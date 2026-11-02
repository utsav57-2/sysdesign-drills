# Design a Distributed Key-Value Store (DynamoDB / Cassandra)

## Requirements

**Functional**
1. `put(key, value)` stores a value (up to ~1 MB) under a key.
2. `get(key)` returns the latest value, or all conflicting versions if replicas diverged.
3. Consistency is configurable per request (e.g. ONE, QUORUM, ALL).
4. Optional delete (implemented as a tombstone) and TTL.

**Non-functional**
- **Highly available:** writes succeed even when nodes or a whole availability zone are down ("always writable", as in Amazon's Dynamo paper).
- **Horizontally scalable:** add nodes to add capacity, with only a small fraction of data moving.
- **Tunable consistency:** callers trade latency and availability against staleness.
- **Low latency:** p99 under ~10 ms for single-key operations inside a region.
- **Scale:** ~100 TB of data, 1M reads/s and 200k writes/s at peak.

**Out of scope**
- Multi-key transactions, secondary indexes and range scans across partitions.

### Back-of-envelope estimates

| Quantity | Estimate | Implication |
|---|---|---|
| Keys | 100 TB / 1 KB average value = 100B keys | Metadata per key must be tiny; no central index of keys |
| Raw storage with N = 3 | 100 TB × 3 = 300 TB | At ~2 TB usable per node, ~150 nodes |
| Replica reads (R = 2) | 1M/s × 2 = 2M replica reads/s | Reads dominate; caching and bloom filters matter |
| Replica writes (N = 3) | 200k/s × 3 = 600k replica writes/s | Every replica gets the write, even if the coordinator waits for only W |
| Load per node | (2M + 600k) / 150 ≈ 17k ops/s | Comfortable for an SSD-backed LSM node |

## Core entities

| Entity | Key fields | Store/Notes |
|---|---|---|
| Item | `key`, `value`, version (vector clock or timestamp), `tombstone`, `ttl` | Partition key = hash(key); stored in each replica's LSM tree |
| Token ring | list of (token, node) for every virtual node | Small; every node has a copy, spread by gossip |
| Node state | `node_id`, address, status (up / suspect / down), heartbeat counter, load | Gossiped |
| Hint | target node, key, value, version | Stored locally on the node that accepted a write for a down replica |

## API

```
PUT /v1/kv/{key}?consistency=QUORUM
    headers: X-Context: <opaque version context from a previous GET>
    body: <bytes>
    → 200 { context }            write reached W replicas
    → 503                        fewer than W replicas reachable

GET /v1/kv/{key}?consistency=QUORUM
    → 200 { values: [<bytes>], context }   one value, or several siblings on conflict
    → 404                        no live value (missing or tombstoned)

DELETE /v1/kv/{key}  headers: X-Context  → 200   (writes a tombstone)
```

- The **context** is the version (vector clock) the client last read. Sending it back on `put` tells the store which versions this write supersedes, which is how conflicts get resolved rather than piling up.
- Returning multiple **siblings** is a deliberate choice (Dynamo, Riak); Cassandra-style stores instead return one value chosen by last-write-wins.
- Any node can serve any request: it becomes the **coordinator** and forwards to the key's replicas. Smart clients can hash the key themselves and go straight to a replica.

## High-level design

```mermaid
flowchart LR
  C(["Client / SDK"]) --> CO["Coordinator<br/>any node"]
  subgraph RING["Token ring, N = 3"]
    N1["Node A<br/>LSM storage"]
    N2["Node B<br/>LSM storage"]
    N3["Node C<br/>LSM storage"]
    N4["Node D<br/>LSM storage"]
  end
  CO -->|"replicate"| N1
  CO -->|"replicate"| N2
  CO -->|"replicate"| N3
  N1 <-.->|"gossip"| N2
  N2 <-.->|"gossip"| N3
  N3 <-.->|"gossip"| N4
  N4 -.->|"hinted handoff"| N3
  N1 <-.->|"Merkle repair"| N3
```

**Write path**
1. The client sends `put(k, v, context)` to any node. That node hashes `k` onto the ring and finds the **preference list**: the first N distinct physical nodes clockwise from the hash.
2. The coordinator increments the vector clock, sends the write to all N replicas, and replies once W of them acknowledge.
3. Each replica appends the write to its commit log (for durability), inserts it into an in-memory memtable, and later flushes it to immutable sorted files (SSTables).

**Read path**
1. The coordinator sends the read to the replicas and waits for R responses.
2. If the versions differ, it returns the newest (or all concurrent siblings) and sends the newest version back to stale replicas: **read repair**.

**Background**
1. Gossip spreads membership and failure information.
2. Hinted handoff replays writes to nodes that were briefly down.
3. Merkle-tree anti-entropy repairs replicas that drifted for longer.

```mermaid
sequenceDiagram
  participant Cl as Client
  participant Co as Coordinator
  participant A as Replica A
  participant B as Replica B
  participant C as Replica C
  Cl->>Co: put k=cart:42, context
  par send to all N=3
    Co->>A: write v, clock
    Co->>B: write v, clock
    Co->>C: write v, clock
  end
  A-->>Co: ack
  B-->>Co: ack
  Note over Co: W=2 acks received
  Co-->>Cl: 200 ok, new context
  C-->>Co: ack (late, still applied)
```

## Deep dives

### Partitioning with consistent hashing

- **Weak:** `node = hash(key) mod S`. Going from 10 to 11 servers changes the result for about 10/11 of keys, so nearly all data moves.
- **Better:** consistent hashing with one position per node. Adding a node moves only ~1/S of the keys, but load is uneven.
- **Best:** consistent hashing with **virtual nodes**.

#### How consistent hashing works

1. Hash every key into a large fixed space (e.g. 0 to 2^64 − 1, treated as a circle).
2. Hash each node to one or more positions (**tokens**) on the same circle.
3. A key belongs to the first node clockwise from its hash. Its N − 1 replicas are the next distinct physical nodes clockwise.

Worked example with a ring of 0–99 and N = 3:

| Node | Token | Owns hashes |
|---|---|---|
| A | 10 | 76–99, 0–10 |
| B | 40 | 11–40 |
| C | 75 | 41–75 |

Key `user:7` hashes to 52, so its primary is C, and its preference list is C, A, B. Now add node D at token 60. Only hashes 41–60 change owner (C → D); everything else stays put. That's the whole point: membership changes move about 1/S of the data.

#### How virtual nodes fix the imbalance

With one token per node, random positions give uneven arcs (above, C owns 35% of the ring and A owns 35% while B owns 30%, and it gets worse with random tokens). When a node dies, its entire range falls onto **one** neighbor. Virtual nodes give each physical node many tokens (Cassandra used 256 per node by default for years; 4.0 lowered the default to 16 with a smarter token allocator). Each physical node then owns many small arcs scattered around the ring, so:

- Load evens out statistically.
- When a node fails or joins, its data streams to or from **many** peers in parallel, so rebuilds are faster.
- A bigger machine gets more tokens, which gives heterogeneous hardware proportional load.

When building the preference list, skip tokens belonging to a physical node already chosen, and ideally pick replicas in different availability zones.

### Replication and quorums (N, R, W)

#### How quorums work

- **N** = number of replicas per key. **W** = acks the coordinator waits for on a write. **R** = replies it waits for on a read.
- If **R + W > N**, every read set overlaps every write set in at least one replica, so a read sees the latest acknowledged write (assuming no sloppy-quorum substitutions, below).

Worked example, N = 3, W = 2, R = 2, replicas A, B, C all start with `v1`:

| Step | A | B | C | What happens |
|---|---|---|---|---|
| 1. put v2 | v2 | v2 | v1 (message delayed) | A and B ack, W = 2 met, client gets success |
| 2. get, R = 2, asks B and C | v2 | v2 | v1 | Responses v2 and v1; coordinator returns v2 (newer clock) |
| 3. read repair | v2 | v2 | v2 | Coordinator writes v2 back to C |

Any two of three replicas overlap with any other two, so the read in step 2 can't miss v2. With R = 1, W = 1 the coordinator might ask only C and return v1: fast but stale.

| Setting (N = 3) | Read cost | Write cost | Behavior |
|---|---|---|---|
| W = 1, R = 1 | lowest | lowest | Eventual consistency, highest availability |
| W = 2, R = 2 | medium | medium | Read-your-writes in the normal case; tolerates 1 replica down |
| W = 3, R = 1 | fast reads | writes fail if any replica is down | Read-heavy data that rarely changes |
| W = 1, R = 3 | slow reads | fast writes | Write-heavy, rarely read |

Quorums are not linearizability: concurrent writes and sloppy quorums can still produce conflicts, which is why versions are needed. This is the CAP trade-off made per request: during a partition, a side with fewer than W replicas either rejects writes (consistency) or accepts them via sloppy quorum (availability).

### Conflict resolution: vector clocks vs last-write-wins

Two clients can write the same key on different sides of a partition. Something must decide what `get` returns afterwards.

- **Weak: last-write-wins by wall-clock timestamp.** Simple and used by Cassandra (per column) and DynamoDB global tables. But clocks skew, and a concurrent update is silently discarded: two people adding items to the same cart lose one item.
- **Better: LWW with hybrid logical clocks** reduces skew problems but still drops concurrent writes.
- **Best for merge-able data: vector clocks** to detect concurrency, plus application-level or CRDT merges.

#### How vector clocks work

A vector clock is a map `{node: counter}`. The coordinator handling a write increments its own counter on top of the context the client sent. Compare two clocks:
- If every counter in X is ≤ the matching counter in Y, X is an ancestor of Y and can be discarded.
- Otherwise they are **concurrent** and both are kept as siblings.

Worked example (the shopping-cart case from the Dynamo paper):

| Step | Write handled by | Resulting clock | Notes |
|---|---|---|---|
| 1 | Sx | D1 `{Sx:1}` | New cart |
| 2 | Sx | D2 `{Sx:2}` | Supersedes D1 |
| 3 | Sy (client 1 read D2) | D3 `{Sx:2, Sy:1}` | Descends from D2 |
| 4 | Sz (client 2 read D2) | D4 `{Sx:2, Sz:1}` | Also descends from D2 |
| 5 | read | returns D3 and D4 | Neither dominates: Sy:1 vs Sz:1 |
| 6 | Sx, context = both | D5 `{Sx:3, Sy:1, Sz:1}` | Client merged (union of carts); dominates both |

```
def compare(a, b):
    a_le_b = all(a.get(n,0) <= b.get(n,0) for n in a|b)
    b_le_a = all(b.get(n,0) <= a.get(n,0) for n in a|b)
    if a_le_b and b_le_a: return EQUAL
    if a_le_b: return BEFORE
    if b_le_a: return AFTER
    return CONCURRENT
```

Clocks grow with the number of coordinators, so entries carry a timestamp and the oldest are truncated past a size limit (Dynamo used about 10), accepting rare false conflicts. **What to say:** "Use LWW for data where losing a concurrent update is fine (profile fields, caches); use vector clocks with siblings, or CRDTs like an OR-set, where it isn't (carts, counters)."

### Handling failures: gossip, hinted handoff, anti-entropy

#### How gossip works

There's no master tracking membership. Every second, each node picks a few random peers and exchanges its table of `(node, heartbeat counter, status, tokens)`, keeping the higher counter for each entry. A change reaches all S nodes in about O(log S) rounds: for 150 nodes, roughly 7–8 rounds. Failure detection uses heartbeat freshness; Cassandra uses a **phi accrual detector**, which turns the gap since the last heartbeat into a suspicion level relative to that node's normal inter-arrival times, instead of a fixed timeout.

#### How hinted handoff works

Suppose C is down when `put(k)` arrives and k's preference list is C, A, B. With a **sloppy quorum**, the coordinator writes to the next healthy node on the ring, D, with a hint "this belongs to C". D stores it in a separate hints area. When gossip shows C is back, D replays the hints to C and deletes them. Writes stay available during short outages. Hints expire after a window (Cassandra's default `max_hint_window` is 3 hours); longer outages need anti-entropy.

#### How Merkle-tree anti-entropy works

Comparing replicas key by key would mean shipping billions of keys. Instead, each replica builds a **Merkle tree** per token range: leaves hash buckets of keys, and each parent hashes its children.

1. Two replicas exchange root hashes. Equal roots mean the range is identical: done, one hash compared.
2. If they differ, compare the children and descend only into differing subtrees.
3. At the leaves, exchange only the keys in mismatched buckets.

Example: a range split into 1,024 leaf buckets of ~100k keys each. If one key differs, the replicas compare about 10 levels × 2 hashes and then sync one bucket of ~100k keys instead of ~100M. This is Cassandra's `nodetool repair`; run it more often than the tombstone grace period (`gc_grace_seconds`, 10 days by default) so deleted data doesn't come back.

### Storage engine on each node

- **Weak:** a B-tree updated in place. Random writes on every put.
- **Best:** an **LSM tree**. Writes append to a commit log and go into a sorted memtable; full memtables flush to immutable SSTables; background compaction merges SSTables and drops overwritten values and expired tombstones. Reads check the memtable, then SSTables newest first, using a **bloom filter** per SSTable to skip files that definitely don't contain the key. Writes become sequential I/O, which suits a write-heavy, always-writable store.

## Follow-up questions

### Why does R + W > N give strong reads, and when does it not?
Any R replicas and any W replicas must share at least one member, so the read contacts someone who has the latest acknowledged write. It breaks down with sloppy quorums (the write may have landed on substitute nodes outside the read set), with concurrent writes (two different latest values), and with failed writes that partially applied. For linearizable operations you need consensus such as Paxos or Raft, which Cassandra offers as lightweight transactions.

### How does a new node join?
It picks tokens (randomly or via an allocator), announces itself through gossip, and streams the data for its new ranges from the current owners. During streaming, writes for those ranges go to both old and new owners so nothing is missed. Once it catches up, it starts serving reads.

### How are deletes handled if replicas can be down?
A delete writes a tombstone with a version rather than removing data, so a replica that missed the delete can't resurrect the value during repair. Tombstones are purged in compaction only after a grace period long enough for repair to have run everywhere.

### What is read repair and is it enough?
When a read sees differing versions, the coordinator pushes the newest version to stale replicas. It only fixes keys that get read, so cold keys can stay inconsistent forever. That's why periodic Merkle-tree anti-entropy is also required.

### How do you handle a hot key?
Consistent hashing spreads keys, not traffic, so one key still lands on N nodes. Add a cache in front for hot reads, let reads go to any replica at R = 1 for tolerant callers, and for hot writes split the key into sub-keys (`counter#0..#9`) and sum on read.

### Where does this design sit in CAP?
It's AP by default: during a partition both sides keep accepting writes, and conflicts are resolved later. Callers can choose CP-like behavior per request with W = ALL or quorum without sloppy substitution, at the cost of failing requests when replicas are unreachable.

### How would you replicate across regions?
Run a full ring per region and replicate asynchronously between regions, with local quorums (Cassandra's LOCAL_QUORUM) so requests don't wait on cross-region latency. Cross-region conflicts then need LWW, vector clocks or CRDTs; DynamoDB global tables use last-writer-wins.

### Why use virtual nodes instead of manually assigning balanced tokens?
Manual balance breaks every time a node is added or removed and requires moving data to rebalance. Many small virtual-node ranges keep load statistically even automatically, spread recovery traffic over many peers, and let you weight bigger machines with more tokens.
