# Design YouTube / Netflix

## Requirements

**Functional**
1. Users upload videos.
2. Users watch videos, with playback that adapts to their network.
3. (Extension) Search videos by title; view counts.

**Non-functional**
- **Smooth playback:** fast start (under ~2 s) and minimal rebuffering on any network.
- **Huge uploads:** up to tens of GB, resumable.
- **Availability over consistency:** a new upload taking minutes to become watchable is fine.
- **Global scale:** ~1B DAU watching, ~500 hours uploaded per minute.

### Back-of-envelope estimates

| Quantity | Estimate | Implication |
|---|---|---|
| Uploads | ~500 hours/min ≈ 720k hours/day | A massive, parallel transcoding fleet |
| Storage per hour | ~1–3 GB original + ~5–10 GB for all renditions | Multiple PB per day before dedupe |
| Egress | 1B DAU × ~1 hour × ~2 Mbps avg ≈ 100s of Tbps at peak | Only a CDN can serve this; origin must be shielded |
| Metadata reads | Billions/day | Cache aggressively; this part is easy |

## Core entities

| Entity | Key fields | Store |
|---|---|---|
| Video | `video_id`, `uploader_id`, `title`, `description`, `status` (uploading → processing → ready), `duration`, `manifest_url` | Metadata DB (sharded MySQL / Cassandra) + cache |
| Rendition | `video_id`, `resolution`, `bitrate`, `codec`, segment prefix | Metadata; files in object storage |
| Segment | ~2–6 s chunk of one rendition | Object storage, served by the CDN |
| Upload | `upload_id`, part ETags, progress | Tracks resumable multipart state |

## API

```
POST /videos                    { title, description, sizeBytes }
     → { videoId, uploadId, partUrls: [presigned PUT URLs] }
PUT  {partUrl}                                                  (client → object storage)
POST /videos/{id}/complete      { parts: [{partNumber, etag}] } → 202 (processing)
GET  /videos/{id}               → { metadata, status, manifestUrl }   (e.g. https://cdn/.../master.m3u8)
GET  /search?q=&cursor=
```

## High-level design

```mermaid
flowchart LR
  U(["Uploader"]) -->|"metadata"| VS["Video service"]
  U ==>|"multipart upload"| RAW[("Object storage<br/>originals")]
  VS --> MDB[("Metadata DB")]
  RAW -->|"upload complete event"| ORC["Pipeline orchestrator"]
  ORC --> Q[["Task queue"]]
  Q --> TW["Transcode workers<br/>per segment, per rendition"]
  TW --> PROC[("Object storage<br/>HLS / DASH segments")]
  ORC --> MDB
  PROC --> CDN["CDN edges"]
  V(["Viewer"]) -->|"GET /videos/id"| VS
  V ==>|"manifest + segments"| CDN
```

**The processing pipeline is a DAG:**

```mermaid
flowchart LR
  A["Validate + probe"] --> B["Split into GOP-aligned chunks"]
  B --> C1["Transcode 240p"]
  B --> C2["Transcode 720p"]
  B --> C3["Transcode 1080p"]
  B --> C4["Transcode 4K"]
  B --> D["Extract audio tracks"]
  A --> E["Thumbnails"]
  C1 --> F["Package HLS / DASH + manifests"]
  C2 --> F
  C3 --> F
  C4 --> F
  D --> F
  F --> G["Mark ready, warm CDN"]
  E --> G
```

**Playback:** the player fetches metadata, then the master manifest from the CDN, picks a rendition based on measured bandwidth and screen size, and fetches segments sequentially, switching renditions between segments as conditions change.

## Deep dives

### Uploading huge files reliably

- **Weak:** a single POST through the API servers: timeouts, no resume, and API servers carrying video bandwidth.
- **Best:** an **S3 multipart upload with presigned part URLs**. The client uploads ~10–100 MB parts in parallel and retries failed parts; it can resume by asking which parts are done. API servers handle only metadata.
- Verify part checksums; on `complete`, the object store assembles the parts and emits an event that starts the pipeline.

### Fast transcoding

- Transcoding a 2-hour 4K film serially takes hours. **Split it into chunks** at keyframe (GOP) boundaries and transcode the chunks **in parallel** across many workers, then concatenate. That's minutes instead of hours.
- Orchestrate with a workflow engine (Temporal, Step Functions) or a DAG scheduler: retries per task, idempotent outputs (deterministic object keys), and progress tracking.
- **Prioritize:** produce a low and a mid rendition first, so the video becomes watchable quickly; 4K and extra codecs (AV1, VP9) follow later.
- Use spot instances for workers; tasks are short and retryable.

### Adaptive bitrate streaming, explained

**The problem:** a single 1080p file stalls on a slow phone connection, and a single 360p file looks bad on a fiber-connected TV. Bandwidth also changes mid-video. ABR lets the player switch quality every few seconds.

**How it's built:** each rendition (e.g. 240p @ 400 kbps … 4K @ 16 Mbps) is cut into short **segments** of 2–6 s, all aligned at the same timestamps, so the player can switch between renditions at any segment boundary. A **manifest** lists everything.

An HLS **master playlist** lists the renditions:

```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
```

Each **media playlist** (e.g. `720p/index.m3u8`) lists that rendition's segments:

```
#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
seg_00000.m4s
#EXTINF:4.0,
seg_00001.m4s
...
#EXT-X-ENDLIST
```

DASH (`.mpd`, XML) carries the same information; CMAF lets one set of segment files serve both HLS and DASH.

**How the player chooses (the ABR algorithm):**
- **Throughput-based:** measure how fast recent segments downloaded and pick the highest bitrate below ~80% of that. Reacts quickly but jumps around with noisy networks.
- **Buffer-based (e.g. BOLA):** pick quality from how many seconds of video are buffered: a low buffer means drop quality to avoid a stall; a full buffer means step up. More stable.
- Real players blend both, start at a conservative bitrate for a fast first frame, and avoid switching too often because visible quality flapping annoys viewers.
- Segment length trade-off: shorter segments react faster and start faster, but mean more requests and slightly worse compression.

### Why videos are split at keyframes (GOPs)

Video codecs don't store every frame in full. A **keyframe (I-frame)** is a complete picture; the frames after it (P/B-frames) store only differences from nearby frames. A **GOP** (group of pictures) is a keyframe plus its dependent frames, typically 2–4 seconds.

- A segment must **start with a keyframe**, otherwise the player has nothing to decode it from. So encoders force keyframes at fixed intervals (e.g. every 2 s) in *every* rendition, which keeps segments aligned across qualities for switching.
- The parallel transcoder splits the source at GOP boundaries for the same reason: each chunk decodes independently, so workers don't need each other's frames.

### Global delivery

- Segments are immutable, so they cache perfectly: a long TTL and no invalidation.
- **Popular content** is pushed ahead of time to edge caches, including ISP-embedded appliances (Netflix Open Connect). The **long tail** is pulled on demand through a regional "origin shield" layer, so the origin isn't hammered.
- Route viewers to the best edge with DNS/anycast plus client-side measurement.

### Metadata, view counts and search

- Video pages are read-heavy: cache metadata in Redis and at the edge.
- **View counts:** player heartbeats → Kafka → stream aggregation → periodic batched updates. Never increment a DB row per view; dedupe and filter bots in the stream.
- **Search:** index title, description, tags and captions in Elasticsearch, kept in sync with metadata via change data capture.

## Follow-up questions

### How do you make a video watchable as fast as possible after upload?
Stream-transcode while uploading (start processing parts as they arrive), transcode the lowest renditions first, and mark the video ready once a minimal ladder exists; higher renditions are appended to the manifest later.

### How would you support live streaming?
Ingest via RTMP/SRT to an ingest server, transcode in real time into a small bitrate ladder, package into short segments (1–2 s, or low-latency HLS/CMAF chunks), and publish a rolling manifest to the CDN. The trade-off is latency vs. stability: smaller segments mean lower latency but more requests and rebuffering risk.

### How do you prevent people from downloading or pirating premium content?
DRM (Widevine, FairPlay, PlayReady): segments are encrypted, and licenses are issued per session by a license server after an entitlement check. Add signed, expiring CDN URLs and forensic watermarking for premium content.

### A video goes viral overnight. What changes?
Its segments get pulled into more and more edge caches automatically. Proactively, detect the view spike and push its segments to more edges; make sure the origin shield absorbs cache misses. Metadata stays cache-served.

### Where do you store originals, and do you keep them forever?
Keep originals in object storage (moving to a cold tier after processing) so you can re-transcode later with better codecs. Generated renditions for rarely watched videos can be deleted and regenerated on demand to save storage.

### How do you recommend videos?
Candidate generation (collaborative filtering, embeddings of watch history) → ranking model (predicted watch time, engagement) → re-ranking for diversity and freshness. Train offline on watch logs, serve with a feature store, and A/B test changes.

### What happens if a transcode worker crashes mid-task?
The task's lease or visibility timeout expires, and another worker retries it. Outputs are written under deterministic keys, so a retry overwrites partial results. After N failures the task goes to a dead-letter queue and the video is flagged for inspection.

### How do you handle different devices (TV, phone, low-end Android)?
The manifest offers multiple codecs and resolutions; the client picks what it supports (e.g. AV1 on new devices, H.264 everywhere). Device profiles can cap the bitrate, e.g. no 4K on small screens.
