# Design a Distributed Cache (Redis / Memcached)

## Requirements

**Functional**
1. `get(key)`, `set(key, value, ttl)`, `delete(key)`; keys expire after their TTL.
2. When memory is full, evict entries according to a policy (LRU by default) instead of rejecting writes.

**Non-functional**
- **Latency:** sub-millisecond server-side; ~1 ms p99 round trip within a data center.
- **Throughput:** ~1M operations/s overall, read-heavy (~10:1).
- **Horizontal scale:** add nodes to add memory and throughput, moving only a small share of keys.
- **Availability:** a node failure loses at most a few seconds of writes and recovers within ~10–30 s; the cache is not the source of truth.
- **Data size:** ~1 TB of cached data, average value ~1 KB.

**Out of scope:** durable storage guarantees, rich data structures, cross-region strong consistency.

### Back-of-envelope estimates

| Quantity | Estimate | Implication |
|---|---|---|
| Number of keys | 1 TB / 1 KB ≈ 1B keys | Per-key overhead matters: 50 extra bytes per key is another 50 GB |
| Memory per node | 64 GB RAM, ~50 GB usable for data | 1 TB / 50 GB = 20 primary nodes |
| With one replica each | 20 × 2 = 40 nodes | Replicas double memory cost but give fast failover |
| Ops per primary | 1M / 20 = 50k ops/s | Comfortable: one Redis process handles ~100k+ simple ops/s |
| Network | 1M ops × 1 KB = 1 GB/s total ≈ 50 MB/s per node | Well under a 10 Gbit/s NIC (~1.25 GB/s), unless one key is very hot |

## Core entities

| Entity | Key fields | Store/Notes |
|---|---|---|
| Entry | `key`, `value` (bytes), `expires_at`, LRU pointers (`prev`, `next`) | In memory on the owning node; hash table plus LRU list |
| Node | `node_id`, `address`, `role` (primary / replica), `status` | Cluster membership, gossip or a coordinator (ZooKeeper / etcd) |
| Ring / slot map | hash range or slot → primary node, replicas | Cached by every client; versioned with an epoch number |

## API

```
GET    key                    → value | nil
SET    key value [EX seconds] [NX|XX]
                              → OK | nil (NX: only if absent, XX: only if present)
DEL    key                    → number of keys removed
EXPIRE key seconds            → 1 | 0
MGET   key1 key2 ...          → [value | nil, ...]

Error replies:
MOVED 3999 10.0.0.12:6379     (this node does not own the key's slot; refresh the map)
OOM command not allowed       (noeviction policy and memory full)
```

- A compact binary or text protocol over persistent TCP connections, not HTTP: JSON parsing and connection setup would cost more than the lookup itself.
- `SET NX` with a TTL doubles as a building block for locks and for "only one request refills this key".
- `MGET` batches lookups to cut round trips; the client groups keys by node and sends one request per node.

## High-level design

```mermaid
flowchart LR
  A1(["App server<br/>smart client"]) -->|"hash key to node"| N1["Node 1 primary"]
  A1 --> N2["Node 2 primary"]
  A1 --> N3["Node 3 primary"]
  N1 -.->|"async replication"| R1["Node 1 replica"]
  N2 -.-> R2["Node 2 replica"]
  N3 -.-> R3["Node 3 replica"]
  CO["Cluster config<br/>etcd or gossip"] -.->|"slot map, failover"| A1
  CO -.-> N1
  CO -.-> N2
  CO -.-> N3
  A1 -->|"on miss"| DB[("Source database")]
```

**Read flow (cache-aside)**
1. The client library hashes the key, looks up the owning node in its cached ring, and sends `GET` over a pooled connection.
2. On a hit the node finds the entry in its hash table, checks `expires_at`, moves the entry to the head of its LRU list and returns it.
3. On a miss the application reads the database and calls `SET key value EX ttl`.

**Write and eviction flow**
4. `SET` inserts or replaces the entry. If memory is above the limit, the node evicts from the tail of the LRU list until it fits.
5. The primary streams the write to its replica asynchronously.

**Failure flow**
6. Nodes and the coordinator detect a dead primary by missed heartbeats, promote its replica, bump the config epoch, and clients refresh their maps (or learn through a `MOVED` reply).

```mermaid
sequenceDiagram
  participant App as App
  participant C as Cache node
  participant DB as Database
  App->>C: GET user:42
  alt hit
    C-->>App: value
  else miss
    C-->>App: nil
    App->>DB: SELECT user 42
    DB-->>App: row
    App->>C: SET user:42 row EX 300
    C-->>App: OK
  end
  Note over App,DB: on update, write DB first, then DEL user:42
```

## Deep dives

### LRU eviction, explained

**Goal:** when memory is full, remove the entry used least recently, and do every operation in O(1).

#### How a hash map plus doubly linked list works

- A **hash map** from key to a list node gives O(1) lookup.
- A **doubly linked list** orders entries by recency: head = most recently used, tail = least. Each node has `prev` and `next` pointers, so it can be unlinked in O(1) given a pointer to it.
- `get`: look up the node, unlink it, and relink it at the head.
- `set`: if present, update and move to head; otherwise insert at head and, if over capacity, remove the tail node from both the list and the map.

```python
class LRU:
    def __init__(self, cap):
        self.cap, self.map = cap, {}
        self.head, self.tail = Node(), Node()        # sentinels
        self.head.next, self.tail.prev = self.tail, self.head

    def _unlink(self, n): n.prev.next, n.next.prev = n.next, n.prev
    def _push_front(self, n):
        n.next, n.prev = self.head.next, self.head
        self.head.next.prev = n; self.head.next = n

    def get(self, k):
        n = self.map.get(k)
        if not n or n.expires_at < now(): return None
        self._unlink(n); self._push_front(n); return n.val

    def set(self, k, v, ttl):
        if k in self.map: self._unlink(self.map[k])
        n = Node(k, v, now() + ttl); self.map[k] = n; self._push_front(n)
        if len(self.map) > self.cap:
            lru = self.tail.prev; self._unlink(lru); del self.map[lru.key]
```

**Worked example (capacity 3):**

| Operation | List after (head → tail) | Evicted |
|---|---|---|
| set A | A | |
| set B | B, A | |
| set C | C, B, A | |
| get A | A, C, B | |
| set D | D, A, C | B (tail) |
| get C | C, D, A | |
| set E | E, C, D | A |

#### What real systems do

- **Redis** does not keep a full linked list (two pointers per key would cost 16 bytes × 1B keys = 16 GB). It stores a 24-bit last-access clock per object and, when it must evict, **samples** a few random keys (`maxmemory-samples`, default 5), keeping a small pool of the best candidates, and evicts the one idle longest. This approximates true LRU closely with almost no memory overhead. It also offers LFU (`allkeys-lfu`), which keeps a small logarithmic access counter that decays over time, and `volatile-*` policies that evict only keys with a TTL.
- **Memcached** divides memory into **slab classes** of fixed chunk sizes (e.g. 96 B, 120 B, 152 B, ...) to avoid fragmentation, and keeps an LRU per slab class. A new item evicts from the LRU of its own size class.
- **Expiry:** checking `expires_at` on access (lazy) leaves expired-but-unread keys in memory, so Redis also runs an active cycle that samples keys with TTLs and deletes expired ones.

### Partitioning with consistent hashing

- **Weak:** `node = hash(key) % N`. Going from 20 to 21 nodes changes the result for about 20/21 ≈ 95% of keys, so almost the whole cache misses at once and the database takes the full load.
- **Better:** consistent hashing with one point per node. Only ~1/N of keys move, but load is uneven.
- **Best:** consistent hashing with **virtual nodes**, or fixed hash slots (Redis Cluster).

#### How consistent hashing works

1. Map the hash space to a ring, e.g. 0 to 2³²−1.
2. Hash each node's ID to a position on the ring.
3. Hash each key to a position and walk clockwise: the first node you meet owns the key.
4. Adding a node takes over only the keys between it and its counter-clockwise neighbor; removing a node hands its keys to the next node clockwise. Everything else stays put.

Worked example on a ring of 0–99: nodes A at 10, B at 45, C at 80. Key hashes: k1 = 30 → B, k2 = 50 → C, k3 = 90 → wraps to A, k4 = 5 → A. Add node D at 60: only keys in (45, 60] move from C to D, so k2 (50) moves and k1, k3, k4 stay. With three nodes, one node's arc might cover 35% of the ring and another 20%, which is why **virtual nodes** exist: each physical node is placed at, say, 100–200 points (`hash("A#0")`, `hash("A#1")`, ...). Arcs average out, and when a node dies its keys spread across all remaining nodes instead of piling onto one neighbor. Stronger machines can get more virtual nodes.

#### Hash slots (Redis Cluster)

Redis Cluster uses a fixed **16,384 slots**: `slot = CRC16(key) mod 16384`, and each primary owns a set of slots. Rebalancing moves whole slots between nodes with `MIGRATE`; clients that hit the wrong node get `MOVED slot host:port` and update their map. Hash tags put related keys together: only the text inside `{}` is hashed, so `user:{42}:profile` and `user:{42}:cart` share a slot and can be used in one multi-key command.

### Replication, failover and hot keys

#### How failover works

Each primary asynchronously streams its writes to one or more replicas. Replication is asynchronous to keep writes sub-millisecond, so acknowledged writes in the last few milliseconds before a crash can be lost; acceptable for a cache.

1. Nodes ping each other (Redis Cluster gossip) every second or so.
2. If a majority of primaries can't reach node 2 for longer than `cluster-node-timeout` (e.g. 15 s), they mark it failed.
3. Its replica requests promotion; a majority of primaries vote, and the replica becomes primary with a higher config epoch.
4. Clients see `MOVED` or connection errors, refresh the slot map, and continue. The old primary rejoins as a replica when it returns.

Requiring a majority avoids split brain where both sides of a network partition promote a primary. For example, with 3 primaries a minority side of 1 cannot elect anything.

#### Hot keys

A celebrity profile or a flash-sale product might take 200k reads/s, all on one node, beyond its CPU and NIC.

| Option | How | Trade-off |
|---|---|---|
| Read from replicas | Client sends reads for the hot key to replicas round-robin | Adds read capacity per replica; reads may be slightly stale |
| **Local near cache** | App servers keep the hottest keys in process memory for 1–5 s | Removes most remote reads; brief staleness; needs hot-key detection (sampling or client counters) |
| Key splitting | Store copies under `product:7#0` .. `#9`; readers pick a random suffix | Spreads across 10 nodes; writes must update all copies |

Hot-key detection: the client samples requests and keeps a count-min sketch or top-K counter, or an operator scans the server (`redis-cli --hotkeys` works when an LFU eviction policy is set).

### Cache invalidation strategies

| Strategy | How it works | Good for | Risk |
|---|---|---|---|
| **Cache-aside** with delete on write | Read: try cache, else DB and fill. Write: update DB, then `DEL key` | Default for most apps | Race below; short TTL as a safety net |
| Write-through | Writes go to the cache, which synchronously writes the DB | Read-after-write consistency | Every write pays both latencies; caches data never read |
| Write-behind | Writes go to the cache; DB is updated asynchronously in batches | Write-heavy counters | Data loss if the cache node dies before flushing |
| TTL only | Entries just expire | Data that tolerates staleness | Stale for up to the TTL |
| CDC-driven invalidation | A consumer of the DB change log deletes affected keys | Many writers, multiple services | More infrastructure; small delay |

**Why delete instead of update on write:** if two writers update the DB in order X then Y but their cache `SET`s arrive as Y then X, the cache holds stale X forever. Deleting makes the next reader refill from the DB.

**The remaining race:** reader R misses and reads old value v1 from the DB; writer W updates the DB to v2 and deletes the key; then R writes v1 into the cache. The cache is stale until the TTL. Fixes: always set a TTL, delete again after a short delay ("delayed double delete"), or use leases. Facebook's memcache paper describes **leases**: on a miss the server hands out a token, and a `set` is accepted only with a still-valid token; a `delete` invalidates outstanding tokens, so R's late write is rejected. Leases also limit the **thundering herd**: only one client per key gets a token at a time, while others wait briefly and retry.

## Follow-up questions

### Why is Redis single-threaded for commands, and does that limit throughput?
Executing commands on one thread avoids locks and makes every command atomic, and the work per command is tiny, so the bottleneck is usually network I/O, not CPU. Redis 6 added I/O threads for reading and writing sockets while keeping execution single-threaded. To use more cores, run several instances per machine, each owning its own slots.

### How do you prevent a cache stampede when a popular key expires?
Only one request should recompute: take `SET lock:key 1 NX EX 5`, refill, then release; others serve the stale value or wait briefly. Alternatively refresh early with probability that grows as expiry approaches, or add random jitter to TTLs so many keys don't expire at the same moment.

### How would you handle cold start after adding a new cluster or losing a node?
Replicas avoid cold starts on failover because the promoted node already has the data. For a brand-new cluster, warm it by replaying recent keys from the old cluster or by shadow-reading through it before switching. Rate-limit cache-miss traffic to the database so it doesn't fall over while the hit rate recovers.

### Memcached or Redis?
Memcached is a simple multi-threaded key-value cache with slab allocation, good for plain object caching at high throughput. Redis adds data structures (hashes, sorted sets, streams), persistence, replication and clustering built in. Most new systems pick Redis unless they need only plain values and want Memcached's multi-threaded simplicity.

### What happens to memory with many small keys?
Per-key overhead (hash table entry, object header, key string, TTL) can exceed the value size. Pack small related fields into one hash per entity; Redis stores small hashes in a compact listpack encoding. Shorter key names and integer-encoded values also help.

### Should the cache persist to disk?
For a pure cache, persistence is optional; replicas are enough to survive a single failure. Redis offers RDB snapshots and an append-only file if a faster restart with warm data is worth the I/O. Never treat the cache as the only copy of data you cannot regenerate.

### How do clients learn about topology changes?
Smart clients cache the slot map and refresh it when they get `MOVED` or connection errors, and periodically. Alternatively, a proxy layer (Twemproxy, Envoy, or a managed endpoint) hides topology from applications at the cost of an extra hop.

### How would you cache across multiple regions?
Run an independent cache cluster in each region next to the application, filled from the regional database replica. Invalidate across regions by publishing delete events from the database change stream to every region. Cross-region synchronous replication would add tens of milliseconds and defeat the purpose.
