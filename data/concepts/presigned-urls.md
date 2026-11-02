# Presigned URLs

## The problem it solves

Users upload 50 MB videos. If every upload passes through your API servers on its way to S3, each server holds a slow mobile connection open for minutes, buffers the bytes, and then re-sends them to storage. At 1,000 concurrent uploads that's 50 GB in flight through servers that exist to run business logic. But you can't just make the bucket public or give clients your cloud credentials.

A presigned URL is a normal storage URL with a time-limited cryptographic signature in its query string. It grants exactly one operation (say, PUT to one specific key) for a few minutes. Your server creates it in microseconds without contacting the storage service, and the client then talks to the blob store directly.

## How it works

1. The client asks your API for permission: "I want to upload `cat.mp4`, 50 MB, video/mp4."
2. The API authenticates the user, checks quotas and file type, chooses an object key, and records a metadata row as `pending`.
3. The API **signs** a URL using its storage credentials. The signature covers the HTTP method, bucket, key, expiry, and optionally headers like `Content-Type`.
4. The client sends the bytes directly to the storage service using that URL.
5. The storage service recomputes the signature from the request and its record of your secret key. If it matches and hasn't expired, it accepts the request.
6. A storage event (or a client callback, verified server-side) tells your API the upload finished, and the row becomes `ready`.

```mermaid
sequenceDiagram
  participant C as Client
  participant A as API server
  participant S as S3
  C->>A: POST /uploads type video/mp4, size 50 MB
  A->>A: auth, validate, key = videos/uuid.mp4
  A-->>C: presigned PUT URL, expires in 10 min
  C->>S: PUT videos/uuid.mp4 with the bytes
  S-->>C: 200 OK
  S->>A: ObjectCreated event
  A->>A: mark file ready, start processing
```

**What the URL looks like** (AWS Signature Version 4, trimmed):

```
https://my-bucket.s3.amazonaws.com/videos/7f3c.mp4
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=AKIA.../20261101/us-east-1/s3/aws4_request
  &X-Amz-Date=20261101T120000Z
  &X-Amz-Expires=600
  &X-Amz-SignedHeaders=host
  &X-Amz-Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7
```

Generating one in code:

```python
url = s3.generate_presigned_url(
    "put_object",
    Params={"Bucket": "my-bucket", "Key": key, "ContentType": "video/mp4"},
    ExpiresIn=600,
)
```

**Downloads work the same way**: a presigned GET lets a user fetch a private file for a few minutes, so the bucket stays private while the app controls who sees what.

**Constraining uploads.** A presigned PUT doesn't by itself cap file size. For tighter control, S3 supports **presigned POST** policies with conditions such as `content-length-range` and key prefix. Always validate the object after upload too (size, type, malware scan) before treating it as trusted.

**Large files.** Combine with multipart upload: the server presigns one URL per part, and the client uploads parts in parallel.

**CDN equivalents.** CDNs offer signed URLs or signed cookies with the same idea, so private content can still be cached at the edge.

## Worked example

1,000 concurrent 50 MB uploads from mobile clients averaging 2 MB/s, so each upload takes 25 s.

| Approach | Bytes through API servers | API work per upload |
|---|---|---|
| Proxy through API | 1,000 × 50 MB = 50 GB in flight, 2 GB/s sustained | Hold a connection for 25 s, stream 50 MB in and out |
| Presigned PUT | 0 | One short request to sign a URL, plus one event to handle |

Expiry timeline for a URL issued at 12:00:00 with `ExpiresIn=600`:

| Time | Request | Result |
|---|---|---|
| 12:00:05 | PUT starts | Accepted |
| 12:09:59 | Another PUT with the same URL | Accepted (still valid; it can overwrite the same key) |
| 12:10:01 | PUT with the same URL | 403, request has expired |

S3 checks expiry when the request starts, so a long upload begun at 12:09 can finish after 12:10.

## Trade-offs

- **Pros:** removes large transfers from your servers; scales with the storage service; bucket stays private; signing is local and cheap; fine-grained per-object, per-operation, time-limited access.
- **Cons:** a URL is a bearer token, so anyone who obtains it can use it until expiry; you can't easily revoke a single URL (rotating the signing credentials revokes all); upload completion must be confirmed separately; limited server-side validation before bytes land.
- **Alternatives:** proxy uploads through your servers (full control, simple, expensive at scale); temporary scoped credentials (e.g. STS) for clients that need many operations; signed CDN cookies for many private assets at once.

## When to use it (and when not)

- **Use it** for user uploads and private downloads in photo sharing (Instagram), file sync (Dropbox, Google Drive), video upload (YouTube), chat attachments (WhatsApp), and for sharing time-limited download links.
- **Don't use it** when the server must inspect or transform data before it's stored (do it via post-upload processing instead, or proxy small payloads), or when access must be revocable instantly.

## In an interview

Say: "The client asks the API for a presigned PUT URL scoped to one generated key and valid for ten minutes, uploads straight to S3, and an S3 event marks the file ready and starts processing, so no video bytes touch our servers." Then be ready to explain how the signature is verified, how you limit size and type, and how you confirm completion.

## Common follow-up questions

### How does the storage service verify the URL without calling your server?
The signature is an HMAC over the request details computed with a secret derived from your credentials. The storage provider already knows that secret, so it recomputes the HMAC and compares, then checks the expiry.

### What if a presigned URL leaks?
It can be used until it expires, only for the exact method and key it was signed for. Keep expiries short, use unguessable keys, and for downloads issue URLs only after a permission check.

### How do you stop users uploading a 10 GB file to a URL meant for 5 MB?
Use a presigned POST policy with a `content-length-range` condition, or sign the expected `Content-Length` header. Also verify size and type after upload and delete anything that doesn't match.

### How do you know the upload finished?
Subscribe to storage event notifications (e.g. S3 ObjectCreated to SQS or Lambda), or have the client call a completion endpoint and verify with a HEAD request. Don't trust the client's claim alone.
