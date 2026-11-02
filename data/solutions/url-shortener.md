# Design a URL Shortener (Bit.ly)

## Requirements

**Functional**
1. Create a short URL from a long URL, optionally with a custom alias and an expiration time.
2. Visiting a short URL redirects to the original URL.

**Non-functional**
- **Uniqueness:** one short code never maps to two URLs.
- **Low latency:** redirects in under ~100 ms at p99, since they sit in front of every click.
- **Availability over consistency** for redirects: a brand-new link taking a second to work everywhere is fine; redirects failing is not.
- **Scale:** ~1B stored URLs, ~100M DAU, heavily read-skewed.

**Out of scope:** user accounts, rich analytics dashboards, spam/malware detection (mention them, then park them).

### Back-of-envelope estimates

| Quantity | Estimate | Why it matters |
|---|---|---|
| New URLs | ~1M/day ≈ 12 writes/s (peak ~100/s) | Writes are tiny; one primary DB handles them |
| Redirects | ~100M DAU × ~10 clicks ≈ 1B/day ≈ 12k reads/s (peak ~100k/s) | Reads dominate, so the design centers on caching |
| Storage | 1B rows × ~500 B ≈ 500 GB | Fits on one large Postgres node; sharding is optional |
| Code length | 62^7 ≈ 3.5 trillion | 7 base62 characters is plenty |

## Core entities

| Entity | Key fields | Notes |
|---|---|---|
| URL mapping | `short_code` (PK), `long_url`, `created_at`, `expires_at`, `user_id?` | Primary key lookups only, which suits any store |
| User | `user_id`, ... | Only needed for custom aliases or managing links |

## API

```
POST /urls
  body: { "longUrl": "https://...", "customAlias"?: "summer-sale", "expiresAt"?: "2026-12-31T00:00:00Z" }
  → 201 { "shortUrl": "https://sho.rt/aZ3kQ9x" }
  → 409 if customAlias is taken, 400 if longUrl is invalid

GET /{shortCode}
  → 302 Location: https://...        (found)
  → 404 (unknown)  |  410 (expired)
```

**302 vs 301:** a 301 (permanent) is cached by browsers, so later clicks never reach you. That breaks analytics, expiration and editing. Use 302 unless the interviewer explicitly wants minimum server load.

## High-level design

```mermaid
flowchart LR
  C(["Client"]) --> LB["Load balancer"]
  LB -->|"POST /urls"| W["Write service"]
  LB -->|"GET /code"| R["Read service"]
  W --> K["ID allocator<br/>Redis INCR, batched"]
  W --> DB[("Postgres<br/>short_code → long_url")]
  R --> RC[("Redis cache")]
  RC -.->|"miss"| DB
  CDN["CDN / edge cache"] -.-> R
```

**Create flow**
1. The write service validates the URL (scheme, length, optionally a blocklist).
2. If there's a custom alias, insert it directly and rely on the primary key's uniqueness (409 on conflict).
3. Otherwise get the next unique integer from the ID allocator, base62-encode it, and insert the row.

**Redirect flow**
1. The read service looks up the code in Redis.
2. On a miss, it reads Postgres and fills the cache (with a TTL no later than `expires_at`).
3. It returns 302 to the long URL, or 404/410.

```mermaid
sequenceDiagram
  participant B as Browser
  participant R as Read service
  participant C as Redis
  participant D as Postgres
  B->>R: GET /aZ3kQ9x
  R->>C: GET aZ3kQ9x
  alt cache hit
    C-->>R: long URL
  else cache miss
    R->>D: SELECT long_url, expires_at
    D-->>R: row
    R->>C: SET with TTL
  end
  R-->>B: 302 Location long URL
```

**Why split read and write services?** Their load differs by ~1000×, so they scale independently. The read path stays tiny and can be deployed close to users.

## Deep dives

### How do you generate unique short codes?

- **Weak: random 7 characters.** Collisions grow as the table fills, so every insert needs check-and-retry, and retries rise over time.
- **Okay: hash the long URL** (MD5/SHA-256, base62, first 7 characters). The same URL always gets the same code (free dedupe), but truncation causes collisions that need check-and-retry, and two users can't get separate links for the same URL.
- **Best: global counter + base62.** A Redis `INCR` returns a unique integer; encoding it gives a guaranteed-unique code with no retries.
  - **Remove the bottleneck:** each write server reserves a block of IDs (e.g. `INCRBY 1000`) and hands them out locally. Redis gets ~1/1000 of the traffic, and a Redis blip doesn't stop writes right away.
  - **Durability:** use Redis persistence (AOF) or a DB sequence as the fallback; if the counter ever goes backwards you'd mint duplicates, so on restart begin from max(id) + a safety gap.

#### How base62 encoding works

Base62 writes a number using 62 symbols, `0-9a-zA-Z` (digits are 0–9, `a` = 10 … `z` = 35, `A` = 36 … `Z` = 61), the same way decimal uses 10 symbols. Repeatedly divide by 62; the remainders are the digits, least significant first.

**Worked example: encode ID 1,000,000**

| Step | Division | Quotient | Remainder → symbol |
|---|---|---|---|
| 1 | 1,000,000 ÷ 62 | 16,129 | 2 → `2` |
| 2 | 16,129 ÷ 62 | 260 | 9 → `9` |
| 3 | 260 ÷ 62 | 4 | 12 → `c` |
| 4 | 4 ÷ 62 | 0 | 4 → `4` |

Read the remainders bottom-up: **`4c92`**. Check: 4×62³ + 12×62² + 9×62 + 2 = 953,312 + 46,128 + 558 + 2 = 1,000,000 ✓.

```
ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
def encode(n):
    s = ""
    while n > 0:
        n, r = divmod(n, 62)
        s = ALPHABET[r] + s
    return s.rjust(7, "0")     # fixed length 7
```

Why 7 characters: 62⁶ ≈ 57 billion and 62⁷ ≈ 3.5 trillion, so 7 characters cover 1B URLs with huge headroom. Base62 (not base64) avoids `+` and `/`, which are awkward in URLs.

#### Making codes unguessable

Sequential IDs give sequential codes (`…4c92`, `…4c93`), so anyone can enumerate every link. Scramble the integer with a **bijection** (a one-to-one mapping) on [0, 62⁷) before encoding. Because it's one-to-one, unique inputs still give unique outputs, so uniqueness is preserved.

- **Multiply by a constant mod 62⁷:** `scrambled = (id × P) mod 62⁷`, where P is coprime to 62⁷. Since 62⁷ = 2⁷ × 31⁷, P must be **odd and not divisible by 31**. Simple and fast, but the pattern is weak against a determined attacker.
- **A Feistel network** (a few rounds of a keyed hash over the two halves of the number) gives a properly shuffled, keyed permutation and is just as cheap.
- You never need to reverse it: the code → URL mapping is stored, so decoding is just a lookup.

#### Cache-aside on the read path

The read service follows the **cache-aside** pattern: read Redis first; on a miss, read the DB and write the result into Redis with a TTL. Only the hot links end up cached. Under memory pressure Redis evicts using **LRU** (least recently used), which suits the power-law click distribution. Writes don't need to touch the cache, because new links aren't hot yet.

### How do redirects stay fast at 100k reads/s?

- Traffic follows a power law: a small set of links gets most clicks. An LRU Redis cache of a few GB gives a 90%+ hit rate.
- Read replicas absorb cache misses; the primary only takes writes.
- Put a CDN or edge workers in front for the hottest links: a 302 from the edge saves the round trip to your region. Use a short cache TTL so expirations still take effect quickly.
- The read service is stateless, so scale it horizontally behind the load balancer.

### Expiration

- Check `expires_at` on every read (cache entries carry it too) and return 410.
- Set the Redis TTL to the smaller of the default TTL and the time remaining before expiry, so expired links fall out on their own.
- A nightly batch job deletes expired rows (or moves them to cold storage) to keep the table small.

### Scaling storage beyond one node

- At 500 GB a single Postgres primary with replicas is fine. If growth demands it, **shard by hash of `short_code`**: lookups always include the code, so each request hits exactly one shard and load spreads evenly.
- DynamoDB or Cassandra are equally good fits for a pure key-value pattern if you'd rather not manage sharding yourself.

## Follow-up questions

### What happens if two users shorten the same long URL?
With the counter approach they get two different codes. That's usually what you want, because each link can have its own expiry and analytics. If dedupe is required, keep a secondary index on `hash(long_url)` and return the existing code, but only for anonymous links without custom settings.

### How would you add click analytics without slowing redirects?
Never write to a database on the redirect path. Emit a click event (code, timestamp, referrer, country from IP) to Kafka asynchronously and return the 302 right away. A stream processor (Flink) aggregates counts per code per minute into an OLAP store like ClickHouse for dashboards. This is also why you keep 302: a 301 would hide clicks.

### Your Redis counter's node dies. What happens?
Write servers keep handing out IDs from the blocks they already reserved, so writes continue briefly. Redis fails over to a replica, but async replication may have lost the last few `INCRBY`s, which could reissue a block. Guard against this: on failover, bump the counter well past the highest ID seen in the database, or allocate blocks from a DB sequence (a strongly consistent source) instead of Redis.

### How do you stop people abusing the service (phishing, spam)?
Rate-limit creation per IP and API key, and check URLs against Safe Browsing or blocklists at creation time and periodically afterwards. Let users report links, and serve a warning interstitial for flagged domains. Deleting a link must also purge it from the cache and CDN.

### A link goes viral and gets 1M requests/second. What breaks?
A single Redis key's shard becomes hot. Absorb it at the edge first: let the CDN cache that redirect for a few seconds. Inside, add an in-process LRU cache on read servers for the top keys, or replicate hot keys under suffixed names (`code#1..n`) and read one at random.

### How would you support editing where a short link points?
Update the row, then invalidate the cache key and purge the CDN. Clients that got a 302 aren't affected, but anyone who received a 301 would keep the old target forever, which is one more reason for 302. Keep an audit log of changes.

### How do you serve users globally with low latency?
Deploy read services and Redis replicas in several regions behind geo-DNS or anycast. Writes go to one primary region (they're rare and can tolerate ~100 ms more). Replicate the database asynchronously to read regions; a link created a moment ago may 404 briefly far away, so the read service can fall back to the primary region on a miss.

### Why not use the database's auto-increment instead of Redis?
You can. A Postgres sequence is durable and strictly unique, and at ~100 writes/s it's nowhere near a bottleneck. Redis earns its place only if writes grow a lot or you shard the database (sequences are per-shard). With block allocation, the sequence is called once per thousand IDs, which works even at very high scale.
