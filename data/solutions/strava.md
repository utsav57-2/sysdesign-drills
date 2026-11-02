# Design Strava (Fitness Tracking)

## Requirements

**Functional**
1. Users start, pause, resume and stop an activity (run, ride) while the phone records a GPS track.
2. After stopping, the activity is saved with stats (distance, time, pace, elevation, map) and shared with followers.
3. Users see a feed of activities from people they follow.
4. Activities are matched against **segments** (user-defined stretches of road or trail), and each segment has a leaderboard of fastest times.

**Non-functional**
- **Works offline:** recording never depends on connectivity; nothing is lost if the phone has no signal for hours.
- **Accurate tracking:** distance within a few percent of truth; GPS noise doesn't inflate distance or create fake records.
- **Scale:** ~100M MAU, ~5M activities uploaded/day, with sharp peaks on weekend mornings.
- **Freshness:** an uploaded activity appears in followers' feeds and on leaderboards within ~1 minute.

**Out of scope:** live tracking for spectators (discussed in follow-ups), clubs and challenges, route planning.

### Back-of-envelope estimates

| Quantity | Estimate | Implication |
|---|---|---|
| Points per activity | 1 hour at 1 point/s = 3,600 points | Store as one blob per activity, not one row per point |
| Raw trace size | 3,600 × ~32 bytes (lat, lng, elevation, time, heart rate) ≈ 115 KB | Delta encoding and compression shrink it ~5× to ~20–25 KB |
| Upload rate | 5M/day ÷ 86,400 s ≈ 58/s average, ~600/s at a 10× weekend peak | Processing goes through a queue to absorb peaks |
| Trace storage | 5M × 115 KB ≈ 575 GB/day raw, ~210 TB/year | Blob storage (S3), cheap tiers for old traces |
| Feed reads | 30M DAU × 10 opens ≈ 300M/day ≈ 3,500/s | Precomputed feeds in a cache |
| Segment efforts | 5M activities × ~5 segments matched ≈ 25M efforts/day | Leaderboard writes ≈ 290/s average |

## Core entities

| Entity | Key fields | Store/Notes |
|---|---|---|
| Activity | `activity_id` (client UUID), `user_id`, type, `start_time`, distance, moving time, elevation gain, `polyline`, `trace_key`, visibility | Postgres/Cassandra, partitioned by `user_id` |
| Trace | `trace_key` → compressed stream of (t, lat, lng, ele, hr) | Blob storage (S3), immutable |
| Segment | `segment_id`, start/end points, polyline, distance, bounding box, geohash cells | Postgres + PostGIS; spatial index on geometry |
| Segment effort | (`segment_id`, `effort_id`), `user_id`, `activity_id`, elapsed time, date | Cassandra partitioned by `segment_id`; source of truth for leaderboards |
| Leaderboard | `segment_id` → sorted set of (user, best time) | Redis sorted sets, rebuildable from efforts |
| Follow | (`follower_id`, `followee_id`) | Graph table, indexed both ways |
| Feed | `user_id` → list of recent `activity_id`s | Redis lists, capped at ~500 entries |

```mermaid
stateDiagram-v2
  [*] --> recording
  recording --> paused: user or auto pause
  paused --> recording: resume
  recording --> stopped: finish
  paused --> stopped: finish
  stopped --> queued_upload: saved locally
  queued_upload --> uploading: network available
  uploading --> queued_upload: failure, retry later
  uploading --> processing: server accepted
  processing --> published: stats, segments, feed done
  published --> [*]
```

## API

```
POST /v1/uploads
     Idempotency-Key: <activity_id, generated on device>
     { activityId, type, startTime, totalBytes, sha256 }
     → 201 { uploadId, chunkSize: 262144 }   200 if already uploaded
PUT  /v1/uploads/{uploadId}/chunks/{n}     (binary, compressed trace chunk)   → 204
POST /v1/uploads/{uploadId}/complete       → 202 { activityId, status: "processing" }
GET  /v1/activities/{activityId}           → { stats, polyline, segmentEfforts: [...] }
GET  /v1/feed?cursor=&limit=20             → { activities: [...], nextCursor }
GET  /v1/segments/{segmentId}/leaderboard?filter=all|following|age_35_44&limit=10
     → { entries: [{ rank, userId, elapsedS, date }], me: { rank, elapsedS } }
POST /v1/activities/{activityId}/kudos     → 204
```

- **The activity ID is generated on the device** and doubles as the idempotency key, so retrying an upload after a dropped connection never creates a duplicate activity.
- **Chunked, resumable uploads:** on a flaky connection the client resumes from the last acknowledged chunk instead of starting over.
- **202 on complete:** stats, segment matching and feed fan-out happen asynchronously; the client polls or gets a push when processing finishes.
- **Cursor pagination** on the feed, encoded as (start_time, activity_id).

## High-level design

```mermaid
flowchart LR
  APP(["Phone app<br/>local SQLite buffer"]) --> GW["API gateway"]
  GW --> UP["Upload service"]
  UP --> BS[("Blob storage<br/>raw traces")]
  UP -->|"activity uploaded"| K[["Kafka"]]
  K --> PROC["Activity processor<br/>clean, stats, polyline"]
  PROC --> ADB[("Activity DB")]
  PROC -->|"activity processed"| K2[["Kafka"]]
  K2 --> SEG["Segment matcher"]
  SEG --> SDB[("Segments<br/>PostGIS")]
  SEG --> EFF[("Efforts<br/>Cassandra")]
  SEG --> LB[("Leaderboards<br/>Redis sorted sets")]
  K2 --> FAN["Feed fan-out"]
  FAN --> FG[("Follow graph")]
  FAN --> FEED[("Feeds<br/>Redis")]
  GW --> FS["Feed service"]
  FS --> FEED
  FS --> ADB
  GW --> LBS["Leaderboard service"]
  LBS --> LB
```

**Record and upload**
1. During recording the app samples GPS (and sensors) about once a second and appends points to a local SQLite database, flushing every few seconds so a crash loses at most a few points.
2. On stop, the app computes provisional stats locally (shown immediately), marks the activity `queued_upload`, and uploads when online.
3. The upload service stores the compressed trace in blob storage, records the activity as `processing`, and publishes an event.

**Processing**
1. The processor smooths the trace, detects pauses, computes distance, elevation gain and moving time, and generates a simplified polyline for maps.
2. The segment matcher finds segments the trace covers, records efforts and updates leaderboards.
3. Feed fan-out pushes the activity ID into each follower's feed; followers get a push notification.

```mermaid
sequenceDiagram
  participant A as App
  participant U as Upload service
  participant B as Blob storage
  participant K as Kafka
  participant P as Processor
  participant S as Segment matcher
  participant F as Feed fan-out
  A->>U: POST uploads with activityId as key
  U-->>A: 201 uploadId, chunk size
  loop each chunk
    A->>U: PUT chunk n
    U->>B: append part
    U-->>A: 204
  end
  A->>U: POST complete
  U->>K: activity uploaded
  U-->>A: 202 processing
  K->>P: process trace
  P->>K: activity processed with stats
  par segments
    K->>S: match segments, update leaderboards
  and feed
    K->>F: push to followers feeds
  end
```

## Deep dives

### Client-side buffering vs server streaming

| Approach | How it works | Pros | Cons |
|---|---|---|---|
| **Weak:** stream every point to the server | POST each second, server assembles the activity | Live view for free | Fails offline, drains battery (radio always on), 1M concurrent recorders = 1M writes/s |
| **Better:** stream in batches every 30 s | Buffer locally, send batches when connected | Live-ish view | Still needs reconciliation for gaps, many partial activities server-side |
| **Best:** record locally, upload the complete activity at the end | Device is the source of truth until upload succeeds | Works fully offline, one write per activity, simple server | No live view by default (add an opt-in beacon) |

#### How offline-first recording works

1. **Durable local buffer:** points go into SQLite in WAL mode with an `activity_id` column. Flushing every ~5 s bounds loss on a crash; on app restart, an unfinished activity is offered for resume.
2. **Upload queue:** finished activities sit in a local queue with state (`queued_upload`, `uploading`, `uploaded`). A background job (iOS background tasks, Android WorkManager) retries with exponential backoff when connectivity returns.
3. **Idempotency:** the device-generated UUID is the server's primary key. If the app uploads, loses the response, and retries, the server returns `200` with the existing activity.
4. **Resumable chunks:** a 115 KB trace is small, but a multi-day ride with sensors may be several MB. Chunks of 256 KB with a server-side record of received parts let the app resume.
5. **Local-only data is deleted** only after the server confirms the activity is processed, never just on HTTP 2xx for a chunk.

Live tracking (Strava's Beacon feature) is a separate, optional stream of a point every ~15–30 s to a small service so a contact can follow along; it never replaces the full upload.

### Storing GPS traces

- **Weak:** one row per GPS point in a relational table. 5M activities × 3,600 points = 18B rows per day; indexes alone would dwarf the data, and nobody queries individual points.
- **Better:** store the trace as a JSON array in the activity row. Simpler, but bloats the primary DB with large, rarely-read blobs.
- **Best:** store the **full trace as a compressed blob** in object storage, and keep only summary stats plus a **simplified encoded polyline** in the activity DB for map rendering.

#### How delta encoding shrinks traces

Consecutive points are close together, so store differences instead of absolute values. Google's encoded polyline format scales coordinates by 1e5 (about 1.1 m precision), stores deltas from the previous point, and writes them as variable-length base64-like characters.

| Point | Lat | Lng | Stored as (×1e5 deltas) |
|---|---|---|---|
| 1 | 37.77490 | −122.41940 | 3777490, −12241940 (full value) |
| 2 | 37.77495 | −122.41932 | +5, +8 |
| 3 | 37.77502 | −122.41921 | +7, +11 |

A full coordinate needs ~5 characters per number; a small delta needs 1. Time deltas are almost always "+1 s", which compresses to nearly nothing with a general-purpose compressor (zstd) on top.

#### How the simplified polyline is made

The Ramer-Douglas-Peucker algorithm drops points that lie within a tolerance (e.g. 5 m) of the straight line between their neighbors. A straight 1 km road segment sampled every second collapses from ~250 points to 2. A typical 3,600-point run becomes a few hundred points, which loads quickly in feeds and maps. The full trace stays in blob storage for analysis and segment matching.

#### How accuracy is protected

- **Smoothing:** a Kalman filter or moving average reduces jitter; without it, a stationary phone wanders a few meters per second and adds fake distance.
- **Drop bad fixes:** discard points with reported horizontal accuracy worse than ~30 m or implied speed above the sport's plausible maximum.
- **Auto-pause:** treat sustained speed below a threshold (e.g. under 1 km/h for several seconds) as stopped, so moving time excludes traffic lights.
- **Elevation:** phone GPS elevation is noisy; correct it with a digital elevation model or the barometer when available.

### Segment matching

A segment is a fixed path, such as a 1.2 km hill climb. For each new activity we must find which of millions of segments it fully traversed, and how long each took.

#### How matching works

1. **Candidate search (spatial index):** compute the activity's bounding box, or the set of geohash cells its simplified polyline passes through, and query PostGIS for segments whose geometry lies in those cells. This cuts millions of segments to tens of candidates.
2. **Start and end detection:** walk the trace and find points within ~25 m of the segment's start, then a later point within ~25 m of its end.
3. **Path verification:** check that the trace between those points stays within a corridor (e.g. 30 m) of the segment polyline for most of its length, so riding from start to end by a shortcut doesn't count.
4. **Timing:** elapsed time = time at the end crossing − time at the start crossing, interpolating between the two GPS points nearest each line for sub-second accuracy.
5. Write the effort to Cassandra (partition `segment_id`) and update the leaderboard.

**Worked example:** segment "Hawk Hill", 1.2 km, start S and end E.

| Trace point | Time | Distance to S | Distance to E | Within corridor? |
|---|---|---|---|---|
| p410 | 07:12:05 | 60 m | 1.2 km | |
| p415 | 07:12:10 | **8 m** (start crossing) | 1.19 km | yes |
| p415–p701 | | | | 97% of points within 30 m: valid |
| p702 | 07:16:57 | 1.2 km | **12 m** (end crossing) | yes |

Elapsed time = 07:16:57 − 07:12:10 = 4 min 47 s = 287 s. Speed check: 1,200 m / 287 s ≈ 4.2 m/s (15 km/h), plausible for a climb on a bike, so the effort is accepted.

### Segment leaderboards

- **Weak:** `SELECT user_id, MIN(elapsed) FROM efforts WHERE segment_id = ? GROUP BY user_id ORDER BY 2 LIMIT 10` on every view. Popular segments have millions of efforts, so this is slow.
- **Best:** keep each user's best time in a **Redis sorted set per segment**, with Cassandra efforts as the durable source of truth.

#### How the sorted set leaderboard works

```
ZADD lb:seg:42 LT 287 user:alice     # LT: add if new, update only if lower (Redis 6.2+)
ZRANGE lb:seg:42 0 9 WITHSCORES      # top 10, fastest first
ZRANK lb:seg:42 user:alice           # alice's 0-based rank, O(log N)
```

| Event | Set before | Command | Set after |
|---|---|---|---|
| Bob rides, 301 s | {} | ZADD LT 301 bob | {bob: 301} |
| Alice rides, 287 s | {bob: 301} | ZADD LT 287 alice | {alice: 287, bob: 301} |
| Alice rides again, 295 s | {alice: 287, bob: 301} | ZADD LT 295 alice | unchanged (295 > 287) |
| Bob rides, 280 s | {alice: 287, bob: 301} | ZADD LT 280 bob | {bob: 280, alice: 287} |

- **Filtered leaderboards:** "people I follow" is computed on read: get the followee IDs (a few hundred) and `ZMSCORE` their best times, then sort in the service. Age, gender and "this year" boards are separate sorted sets updated at the same time, since those dimensions are fixed per effort.
- **Memory:** one entry is ~100 bytes; even 500M (segment, user) bests ≈ 50 GB, sharded across a Redis cluster by segment ID.
- **Integrity:** flagged or deleted activities remove their efforts, and the leaderboard entry is recomputed from Cassandra (the next best effort for that user). Implausible efforts (speed far above the sport's record) are held for review before entering top ranks.

### Feed fan-out

Most users have under a few hundred followers, so **fan-out on write** works: on publish, push the activity ID into each follower's Redis list (`LPUSH` then `LTRIM` to 500). For accounts with millions of followers (professional athletes), skip fan-out and merge their recent activities at read time. Feed reads fetch IDs from Redis, then hydrate summaries and polylines from the activity DB through a cache.

## Follow-up questions

### How would you build live tracking for spectators?
An opt-in mode streams a point every ~15 s over HTTPS to a live-location service that keeps the latest position in Redis and publishes it to watchers over WebSocket. It runs alongside local recording, and the final activity is still uploaded in full at the end.

### How do you handle privacy zones around a user's home?
Users define circles (e.g. 200 m around home). When generating public polylines and maps, the processor trims points inside those zones; the raw trace stays private. Segment matching can still use the full trace for the owner's own efforts.

### What if a user's phone clock is wrong?
Use GPS timestamps, which come from satellite time and are accurate, rather than the device clock. The server also records receipt time and rejects activities with impossible dates.

### How do you create new segments?
A user selects a stretch of one of their activities; the server snaps it to the trace, de-duplicates against existing nearby segments, and inserts it into PostGIS. A backfill job matches historical activities near the segment to seed its leaderboard asynchronously.

### How do you prevent cheating on leaderboards?
Speed and acceleration checks per sport, flagging rides done in a car (sustained speeds too high), comparing heart rate or power data when present, and community flagging. Suspicious efforts are excluded from top ranks until reviewed.

### What happens if the segment matcher is down for an hour?
Uploads and feeds keep working because matching is a separate Kafka consumer. Events pile up in Kafka, and when the matcher recovers it processes the backlog; leaderboards are briefly stale, then catch up.

### How would you support importing from Garmin and other devices?
Devices produce FIT or GPX files, which go through the same upload path after a parser normalizes them into the internal trace format. De-duplicate imports that overlap with an activity recorded on the phone by comparing start time and track overlap.

### How do you compute heatmaps of popular routes?
A batch job (Spark) rasterizes all public traces into map tiles, counting passes per pixel, and renders tiles at multiple zoom levels. Tiles are static files served from a CDN and rebuilt periodically.
