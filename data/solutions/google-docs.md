# Design Google Docs (Collaborative Editor)

## Requirements

**Functional**
1. Create, open and edit rich-text documents.
2. Multiple users edit the same document at the same time and see each other's changes in real time.
3. See other editors' cursors and selections, with their names.
4. View revision history (nice to have).

**Non-functional**
- **Convergence:** after everyone stops typing, every replica of the document is identical (eventual consistency), and each user's intent is preserved where possible.
- **Low latency:** your own keystrokes appear instantly (local apply); others' edits appear within ~100 ms in the same region.
- **Durability:** an edit acknowledged by the server is never lost.
- **Scale:** ~100M DAU, ~10M documents open at peak, usually 1–10 editors per document, with a cap (~100 concurrent editors) per document.

**Out of scope:** comments, suggestions mode, offline-first sync beyond short disconnects, spreadsheets.

### Back-of-envelope estimates

| Quantity | Estimate | Implication |
|---|---|---|
| Concurrent connections | ~10M open sessions | At ~100k WebSockets per server, ~100 collaboration servers |
| Edit rate | ~1M actively typing users × ~1 batched op/s (keystrokes grouped every ~200–500 ms) ≈ 1M ops/s | Op log must take ~1M small appends/s, sharded by `doc_id` |
| Op size | ~100 bytes | 1M × 100 B = 100 MB/s ≈ 8.6 TB/day of raw ops before compaction |
| Snapshot cadence | every ~1,000 ops | Loading a doc reads one snapshot plus ≤ 1,000 ops, not the full history |
| Document size | typical doc ~100 KB as snapshot | 1B docs × 100 KB = 100 TB of snapshots in object storage |

## Core entities

| Entity | Key fields | Store/Notes |
|---|---|---|
| Document | `doc_id`, `title`, `owner_id`, `current_rev`, `snapshot_rev` | Metadata DB (Postgres / Spanner) |
| Operation | (`doc_id`, `rev`) → `op` (insert/delete/format), `user_id`, `client_id`, `client_seq`, `ts` | Op log: Bigtable / Cassandra, partition key `doc_id`, clustering key `rev`; append-only |
| Snapshot | (`doc_id`, `rev`) → serialized document | Object storage (S3 / GCS), pointer in metadata |
| Permission | (`doc_id`, `user_id`) → `role` (owner / editor / commenter / viewer) | Metadata DB; cached at the collaboration server |
| Presence | `doc_id` → {`user_id`, `cursor`, `selection`, `color`} | In memory on the collaboration server only; never persisted |

## API

```
POST /v1/docs                  { title }        → 201 { docId }
GET  /v1/docs/{docId}                           → 200 { snapshot, rev, ops: [ops after snapshot] }
GET  /v1/docs/{docId}/revisions?cursor=         → 200 { revisions: [...], nextCursor }

WebSocket wss://collab.example.com/docs/{docId}?rev=1042   (auth via token)

client → server
  { type: "op", clientSeq: 17, baseRev: 1042, op: [{ retain: 5 }, { insert: "hi" }] }
  { type: "cursor", index: 7, selectionEnd: 7 }
server → client
  { type: "ack", clientSeq: 17, rev: 1043 }
  { type: "op", rev: 1044, userId: "u2", op: [...] }
  { type: "presence", userId: "u2", index: 30 }
  { type: "error", code: 403 }      (no edit permission)
```

- **`baseRev`** says which server revision the op was written against; the server transforms it against anything newer.
- **`clientSeq`** makes resends idempotent: after a reconnect the client resends unacknowledged ops, and the server skips any `(client_id, clientSeq)` it already applied.
- Ops use a retain/insert/delete format (as in OT libraries like ot.js and Quill's Delta), which is compact and transformable.
- Identity and permissions come from the token checked at WebSocket upgrade; viewers can receive ops but their op messages are rejected.

## High-level design

```mermaid
flowchart LR
  C1(["Editor A"]) -->|"WebSocket"| LB["L7 load balancer<br/>routes by doc_id"]
  C2(["Editor B"]) -->|"WebSocket"| LB
  LB --> CS1["Collab server 1<br/>owns docs by hash"]
  LB --> CS2["Collab server 2"]
  REG[("Coordination<br/>etcd: doc to server")] -.-> LB
  CS1 -->|"append op"| OL[("Op log<br/>Bigtable, key doc_id+rev")]
  CS1 --> SNAP["Snapshot worker"]
  SNAP --> OBJ[("Object storage<br/>snapshots")]
  CS1 --> META[("Metadata DB<br/>docs, permissions")]
  C1 -->|"HTTPS load doc"| API["Doc API"]
  API --> META
  API --> OBJ
  API --> OL
```

**Open flow**
1. The client calls `GET /docs/{id}`; the doc API returns the latest snapshot and the ops after it. The client builds the document locally at revision R.
2. It opens a WebSocket with `?rev=R`. The load balancer routes it to the collaboration server that owns this doc (see routing below); the server sends any ops after R.

**Edit flow**
3. The user types; the client applies the change locally at once, then sends the op with `baseRev`.
4. The server transforms the op against ops committed since `baseRev`, assigns the next revision, appends it to the op log, then acks the sender and broadcasts the transformed op to other editors.
5. Other clients transform the incoming op against their own unacknowledged ops and apply it.

**Background flow**
6. Every ~1,000 ops, a snapshot worker applies ops to the previous snapshot and writes a new one. Cursor updates go only through server memory.

```mermaid
sequenceDiagram
  participant A as Editor A
  participant S as Collab server
  participant L as Op log
  participant B as Editor B
  A->>A: apply insert locally
  A->>S: op baseRev 10, clientSeq 5
  S->>S: transform against revs after 10
  S->>L: append rev 11 conditional on rev 10 being last
  L-->>S: ok
  S-->>A: ack clientSeq 5 is rev 11
  S->>B: op rev 11 transformed
  B->>B: transform against own pending ops, apply
  B->>S: cursor index 30
  S->>A: presence B at 30
```

## Deep dives

### OT versus CRDTs, explained

**The problem:** the document is "abc". Alice inserts "X" at index 1 (→ "aXbc"). At the same time Bob deletes index 2, the "c" (→ "ab"). If each simply applies the other's op as sent, Alice deletes index 2 of "aXbc", which removes "b", giving "aXc", while Bob inserts at 1 of "ab", giving "aXb". The replicas diverge.

#### How operational transformation (OT) works

OT adjusts an incoming op to account for concurrent ops already applied. For two ops created against the same state, `transform(a, b)` returns `a'` such that applying `b` then `a'` gives the same result as `a` then `b'`. Core rules for plain-text insert and delete:

```
transform(ins(p1, s), ins(p2, _)):   p1 < p2 or (p1 == p2 and tiebreak) → ins(p1, s) else ins(p1 + len, s)
transform(del(p1), ins(p2, s)):      p1 < p2 → del(p1) else del(p1 + len(s))
transform(ins(p1, s), del(p2)):      p1 <= p2 → ins(p1, s) else ins(p1 - 1, s)
transform(del(p1), del(p2)):         p1 < p2 → del(p1); p1 > p2 → del(p1 - 1); equal → no-op
```

Worked example with a central server (the Jupiter/Google Wave style that Google Docs uses: the server picks one order, so transforms only need to work pairwise):

| Step | Server log | Alice's doc | Bob's doc |
|---|---|---|---|
| Start, rev 0 | | abc | abc |
| Alice types ins(1,"X"), Bob types del(2), both locally | | aXbc | ab |
| Server receives Alice's op first (base 0): becomes rev 1 | rev1 = ins(1,"X") | aXbc | ab |
| Server receives Bob's del(2) with base 0; transform against rev 1: 2 ≥ 1, so del(3); becomes rev 2 | rev2 = del(3) | aXbc | ab |
| Alice receives rev 2 del(3) | | aXb | ab |
| Bob receives rev 1 ins(1,"X"); transform against his pending del(2): 1 ≤ 2, unchanged | | aXb | aXb |

Both converge to "aXb", and both intents survive: X is inserted after "a", and "c" is deleted. Each client keeps a queue of sent-but-unacked ops and transforms incoming server ops through that queue. Clients send one op at a time and wait for the ack before sending the next (buffering local edits meanwhile), which keeps the server's transform simple.

#### How CRDTs work

A sequence CRDT (RGA, YATA as used by Yjs, Automerge) avoids positions altogether. Every character gets a globally unique ID `(clientId, counter)`, and an insert says "put this character immediately after the character with ID L". Deletes mark the character as a tombstone instead of removing it, so later ops can still refer to it.

Same example: "a" = (s,1), "b" = (s,2), "c" = (s,3). Alice's op is `insert X id (A,1) after (s,1)`. Bob's op is `delete (s,3)`. These commute: whichever order a replica applies them, X ends up after "a" and "c" is tombstoned, giving "aXb". If two users insert after the same character concurrently, a deterministic rule (for example, order by ID) decides which comes first, so every replica agrees without a server.

| | OT | CRDT |
|---|---|---|
| Needs a central server | Practically yes (it orders ops) | No: merge works peer-to-peer and offline |
| Metadata overhead | Small: ops reference positions | IDs per character plus tombstones; modern libraries compress this well |
| Complexity | Transform functions for every op pair, notoriously hard for rich text | Data structure is complex but merges are mechanical |
| Used by | Google Docs, Etherpad | Figma (CRDT-inspired, server-ordered), Yjs and Automerge users |

**Choice:** we have a server in the loop anyway for durability and permissions, so **server-ordered OT** is a sound, proven answer. Choose a CRDT if offline editing or peer-to-peer sync is a requirement.

### Routing WebSocket connections by document

OT with a central order requires that one process sequence all ops for a document.

- **Weak:** any server accepts any connection and they coordinate through a shared database lock per op. Every keystroke pays a distributed lock round trip.
- **Better:** any server accepts connections and publishes ops to a pub/sub channel per doc (Redis). Broadcast works, but ordering and transforming still need a single sequencer.
- **Best:** **assign each document to one collaboration server** and route all its connections there.

#### How doc-to-server routing works

1. Hash `doc_id` onto a consistent-hash ring of collaboration servers (with virtual nodes), so each server owns a slice of documents and adding a server moves only ~1/N of them.
2. The L7 load balancer (Envoy or a thin routing tier) reads `doc_id` from the WebSocket URL and forwards the upgrade to the owner.
3. Ring membership lives in etcd or ZooKeeper; servers hold a lease. If a server dies, its lease expires (~10 s), its docs map to the next servers on the ring, and clients reconnect with their last `rev`.
4. **Fencing:** the new owner must not accept ops while the old one might still be writing. The op log append is conditional (`insert rev N only if rev N does not exist`), so a stale owner's write fails and it stops serving the doc.

A single document's load is small (at most ~100 editors), so one server per doc is never a bottleneck; the hash spreads millions of docs evenly.

### Operation log and snapshots

The document is **event-sourced**: the op log is the source of truth, and the document at any revision is the result of replaying ops.

#### How durable writes and loading work

- **Write:** the server appends `(doc_id, rev, op)` to the op log and waits for the replicated write before acking the client or broadcasting. If the server crashes after the append but before the ack, the client resends the op on reconnect and the server recognizes `(client_id, clientSeq)` as already applied, returning the existing revision.
- **Conditional append** keeps revisions gapless and unique:

```sql
-- Spanner / Postgres style; Bigtable uses CheckAndMutateRow
INSERT INTO ops (doc_id, rev, op, client_id, client_seq)
VALUES ('d1', 1043, '[{"retain":5},{"insert":"hi"}]', 'cA', 17);
-- primary key (doc_id, rev) rejects a duplicate rev 1043
```

- **Snapshot:** every 1,000 ops (or after 10 minutes idle), a worker loads snapshot at rev S, applies ops S+1..S+1000, and writes a new snapshot to object storage, then updates `snapshot_rev`. Loading a doc at rev 10,500 reads the snapshot at 10,000 plus 500 ops.
- **History:** keep snapshots at coarser intervals (hourly, daily) for the revision-history UI; ops older than the retained snapshots can be compacted or moved to cold storage.

| Doc rev | Stored | Load cost |
|---|---|---|
| 0–999 | ops only | up to 1,000 ops |
| 1,000 | snapshot S1 | 1 snapshot |
| 1,742 | S1 + 742 ops | 1 snapshot + 742 ops |
| 2,000 | snapshot S2 | 1 snapshot |

### Cursors and presence

Cursors change on every keystroke but have no long-term value, so they skip the op log entirely. The client sends cursor positions throttled to ~10–20 per second; the server keeps them in memory per doc and broadcasts them. A cursor index must also be transformed: when an op inserts 3 characters before your cursor at 30, every client shifts your displayed cursor to 33 using the same transform rules as a delete or insert position. If a user disconnects, the server removes their cursor after a short timeout.

## Production readiness

### Database choice and consistency

- **Op log: a wide-column store (Bigtable/Cassandra-style) keyed `(doc_id, rev)`.** It takes ~1M small appends/s spread over millions of partitions and serves "all ops for this doc after rev R" as one range scan. The only transaction we need is the conditional append that makes `rev` unique and gapless, which is a single-row check-and-set, not a multi-row transaction. A single relational cluster was rejected at this write rate; sharded Postgres would work but buys joins we never use. If you pick Cassandra, the conditional append needs lightweight transactions (Paxos), which are slower; that is acceptable only because one doc's write rate is low.
- **Metadata and permissions: relational (Postgres or Spanner).** Sharing, ownership transfer and ACL changes are low-volume and need ACID plus secondary indexes ("docs shared with me").
- **Snapshots: object storage.** Immutable 100 KB blobs, 100 TB total; no reason to pay database prices.
- **Presence: memory only (BASE, lossy).** A dropped cursor is harmless.
- **CAP stance:** the op log path is **CP** per document. During a partition, the collab server that can't reach the op log or loses its lease stops acking edits; clients keep typing locally and resend later. That is the right trade for "an acknowledged edit is never lost". Convergence between clients is eventual by design (OT), but the ordering is strong because one sequencer per doc exists.

### Service boundaries and communication

- **Collaboration servers** (stateful, own docs by hash, hold WebSockets), **Doc API** (stateless HTTPS: load, create, history), **Snapshot workers**, **Metadata/permissions service**, **coordination (etcd)**. Collab servers are split from the Doc API because they are stateful and sticky; loading a doc should keep working while collab ownership is moving.
- **Synchronous:** op append to the op log before ack (durability is the promise); permission check at WebSocket upgrade; doc load.
- **Asynchronous:** snapshotting and compaction, permission-change notifications to the owning server, and search indexing from the op stream. None are on the keystroke path.
- **Don't split** transform and sequencing: an extra hop per op would eat the ~100 ms budget.

### Failure modes and reliability

| Failure | Effect | Mitigation |
|---|---|---|
| Collab server crashes | Its docs stop accepting edits for ~10 s (lease expiry) | Ring reassigns docs; clients reconnect with backoff + jitter and resend unacked ops, deduped by `(client_id, clientSeq)`; conditional append fences the old owner |
| Op log write latency spikes | Acks slow; users see "saving…" | Per-append timeout, retry on the same rev (idempotent); client buffers edits locally; shed new doc opens on that server before slowing active editors |
| Mass reconnect after a zone outage (millions of sockets) | Load balancer and Doc API swamped | Jittered reconnect, server-advertised retry delay, reconnect with `rev` so only missing ops are sent, not full snapshots |
| Snapshot worker falls behind | Doc loads replay many thousands of ops; slow opens | Queue snapshot jobs per doc, prioritize hot docs, alert on "ops since last snapshot"; poison docs that fail to replay go to a dead-letter queue for investigation |
| Transform bug causes divergence | Users see different text | Checksum comparison (see follow-ups), force reload, feature-flag new op types for quick rollback |

### High availability and disaster recovery

- **SPOFs:** a doc's owning server is a deliberate single point per doc, made acceptable by fast lease failover and the fact that clients keep editing locally meanwhile. etcd is a quorum, not a single node. The op log replicates across zones before ack.
- **Zone vs region:** run each region's collab tier across three zones. Writes for a doc go to one region (its owner), so op log replication across regions is async. A synchronously replicated multi-region store (Spanner-style) gives RPO 0 across regions but adds tens of ms to every ack, so use it only if the business demands it.
- **RPO/RTO:** **RPO 0 for acknowledged edits within a region**; unacked edits survive in the client buffer. Cross-region **RPO ≤ a few seconds**. **RTO ≤ 30 s** for a server failure (lease plus reconnect) and **≤ 15 minutes** for a region loss.
- **Backups:** versioned, cross-region snapshots and point-in-time metadata backups target infrastructure loss and bugs; revision history covers user mistakes.

### Security

- **Authn:** short-lived token checked at WebSocket upgrade; long sessions re-validate the token periodically so a revoked user doesn't keep editing for days.
- **Authz:** owner/editor/commenter/viewer per doc, cached on the owning server and invalidated on change (see follow-ups). Link sharing ("anyone with the link") uses unguessable IDs and can be restricted to a domain for enterprise tenants.
- **Tenant isolation:** enterprise domain policies (no external sharing, data region pinning) are enforced in the metadata service, never the client.
- **Encryption:** TLS everywhere; op log and snapshots encrypted at rest with KMS keys rotated on a schedule, optionally customer-managed.
- **Audit log:** opens, shares, permission changes and exports, for admins. Document content is the PII here, so it never goes into application logs.
- **Abuse:** per-user op rate limits (a script sending 10k ops/s is cut off), size limits per doc, scanning of publicly shared docs for phishing.

### Observability

- **SLIs/SLOs (30 days):**
  - 99.9% of ops acknowledged within 300 ms (server-side).
  - 99% of remote edits delivered to same-region collaborators within 100 ms of ack.
  - 99.95% of document opens succeed within 2 s.
  - Zero acknowledged ops lost (checked by reconciling client acks with the op log in canaries).
- **Dashboards:** append latency per op-log shard, connections per collab server, ownership moves/min, snapshot lag, checksum mismatches.
- **Traces:** sampled op round trips (send → transform → append → ack → broadcast) and doc opens (metadata, snapshot, replay).
- **Paging:** burn rate on the ack-latency and open-success SLOs; any spike in checksum mismatches pages, because divergence is silent corruption. A single server's high CPU is not a page if SLOs hold.

### Performance and cost

- **Bottleneck:** op log appends at ~1M/s. Clients already batch keystrokes every 200–500 ms; the server can also group several docs' appends into one batched write per op-log tablet, trading a few ms of latency for throughput. Snapshot every ~1,000 ops keeps load cost bounded.
- **Op log storage (largest cost):** 8.6 TB/day raw is ~3.1 PB/year, ~9.4 PB with 3× replication if never compacted. Compact ops older than the retained history snapshots and compress them (text ops compress well); the trade-off is coarser revision history for old docs.
- **Snapshots:** 100 TB of current snapshots plus history snapshots; tier old ones to cold storage, accepting slower opens of rarely used revisions.
- **Connections:** ~100 collab servers for 10M sockets is modest; disconnecting idle tabs and resuming by `rev` cuts it further, at the cost of a short reconnect.
- **Cross-region egress:** replicating ~100 MB/s of ops to a second region is ~8.6 TB/day of transfer, a real line item; batching and compressing the replication stream is the lever, traded against a slightly larger cross-region RPO.

## Follow-up questions

### What happens when a user goes offline for a few minutes and keeps typing?
The client keeps applying edits locally and queues them. On reconnect it sends its base revision; the server sends all ops since then, the client transforms its queued ops against them, and resends. For long offline periods with many changes, a CRDT handles merging more gracefully than OT.

### How do you handle rich text formatting, not just plain characters?
Use an op format with attributes, such as Quill Delta's `retain(n, {bold: true})`. Transforms must handle overlapping formatting ranges, for example by letting the later op win on conflicting attributes. Block structures like tables need their own op types, which is where OT gets complex.

### How do you enforce permissions?
Check the role at WebSocket upgrade and cache it on the collaboration server. Viewers receive ops but any op they send is rejected with 403. When permissions change, the metadata service notifies the owning server, which downgrades or disconnects the session immediately.

### How would you support undo?
Undo is per user, not global: undoing your last op means generating its inverse (an insert becomes a delete of the same text) and transforming it against everything that happened since. The result is sent as a normal new op, so it goes through the same ordering and history.

### What if a document has 1,000 simultaneous viewers?
Editors stay on the owning server, but read-only viewers can be fanned out through a pub/sub tier or additional relay servers that subscribe to the doc's op stream. Cursor broadcasts are sampled or hidden above a threshold. Google Docs itself limits simultaneous editors and shows viewers differently at high counts.

### Why not store the document as a single row and update it on each keystroke?
Every keystroke would rewrite the whole document and concurrent writers would overwrite each other. The op log turns edits into small appends, gives a total order, and provides revision history for free.

### How do you keep latency under 100 ms for users in different regions?
Place the document's owning server in the region of most of its editors, chosen at open time. Local edits always apply instantly, so only the remote-echo latency depends on distance. Cross-continent collaborators will see 100–200 ms for each other's edits, which is acceptable.

### How do you detect and fix divergence caused by a bug?
Clients periodically send a checksum of their document at a given revision; the server compares it with its own. On mismatch the client discards local state and reloads the snapshot plus ops. Log the case, since it signals a bug in the transform functions.
