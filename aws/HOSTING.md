# Altiora Estudio — hosting on S3 + CloudFront + Route 53

Serves the Angular SPA at **https://altioraestudio.com** via CloudFront, with the
build in the existing S3 bucket and DNS in your Route 53 hosted zone.

## Your resources (already in the account)

| Thing | Value |
|-------|-------|
| Site S3 bucket | `estudioai-229975483756-us-east-1-an` (us-east-1, static website enabled) |
| Domain | `altioraestudio.com` |
| Route 53 hosted zone | `Z07510822ENCEPFWNN4NA` |
| Account / region | `229975483756` / `us-east-1` |

Architecture: **CloudFront → S3 website endpoint (public)**, cert from ACM,
DNS alias in Route 53. SPA deep links are handled by a CloudFront custom error
response that rewrites 403/404 → `/index.html`.

---

## 1. Request + validate the ACM certificate (us-east-1)

CloudFront certs MUST be in **us-east-1**. Request one covering the apex and www:

```bash
CERT_ARN=$(aws acm request-certificate \
  --region us-east-1 \
  --domain-name altioraestudio.com \
  --subject-alternative-names www.altioraestudio.com \
  --validation-method DNS \
  --query CertificateArn --output text)
echo "$CERT_ARN"
```

Get the DNS validation records ACM wants:

```bash
aws acm describe-certificate --region us-east-1 --certificate-arn "$CERT_ARN" \
  --query "Certificate.DomainValidationOptions[].ResourceRecord" --output json
```

For **each** record returned, add it to Route 53 (CNAME). Example for one:

```bash
aws route53 change-resource-record-sets --hosted-zone-id Z07510822ENCEPFWNN4NA \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "<Name from ACM>",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{ "Value": "<Value from ACM>" }]
      }
    }]
  }'
```

Wait until the cert is issued (a few minutes):

```bash
aws acm wait certificate-validated --region us-east-1 --certificate-arn "$CERT_ARN"
echo "cert validated"
```

---

## 2. Create the CloudFront distribution

The origin is the **S3 website endpoint** (not the bucket REST endpoint), so S3
serves the static site and CloudFront caches it.

S3 website endpoint for this bucket (us-east-1):
`estudioai-229975483756-us-east-1-an.s3-website-us-east-1.amazonaws.com`

Create `aws/cloudfront-config.json` (template below), then:

```bash
aws cloudfront create-distribution --distribution-config file://aws/cloudfront-config.json \
  --query "Distribution.{Id:Id,Domain:DomainName}" --output json
```

Key parts the template includes:
- **Origin:** the S3 website endpoint, `customOriginConfig` with HTTP-only
  (S3 website endpoints don't support HTTPS; CloudFront still serves HTTPS to
  visitors).
- **ViewerCertificate:** the ACM cert ARN, `sni-only`, min TLS 1.2.
- **Aliases:** `altioraestudio.com` and `www.altioraestudio.com`.
- **DefaultRootObject:** `index.html`.
- **Custom error responses:** 403 and 404 → `/index.html` with 200, so Angular
  router deep links work.
- **ViewerProtocolPolicy:** `redirect-to-https`.

> After creating, note the distribution's `Id` and its `*.cloudfront.net`
> domain — you need both below.

---

## 3. Point the domain at CloudFront (Route 53 alias)

Create A (and AAAA) alias records for apex + www pointing at the distribution.
CloudFront's hosted-zone id is the fixed value `Z2FDTNDATAQYW2`.

```bash
DIST_DOMAIN="<dxxxx>.cloudfront.net"   # from step 2

aws route53 change-resource-record-sets --hosted-zone-id Z07510822ENCEPFWNN4NA \
  --change-batch "{
    \"Changes\": [
      { \"Action\": \"UPSERT\", \"ResourceRecordSet\": {
          \"Name\": \"altioraestudio.com\", \"Type\": \"A\",
          \"AliasTarget\": { \"HostedZoneId\": \"Z2FDTNDATAQYW2\", \"DNSName\": \"$DIST_DOMAIN\", \"EvaluateTargetHealth\": false } } },
      { \"Action\": \"UPSERT\", \"ResourceRecordSet\": {
          \"Name\": \"altioraestudio.com\", \"Type\": \"AAAA\",
          \"AliasTarget\": { \"HostedZoneId\": \"Z2FDTNDATAQYW2\", \"DNSName\": \"$DIST_DOMAIN\", \"EvaluateTargetHealth\": false } } },
      { \"Action\": \"UPSERT\", \"ResourceRecordSet\": {
          \"Name\": \"www.altioraestudio.com\", \"Type\": \"A\",
          \"AliasTarget\": { \"HostedZoneId\": \"Z2FDTNDATAQYW2\", \"DNSName\": \"$DIST_DOMAIN\", \"EvaluateTargetHealth\": false } } }
    ]
  }"
```

---

## 4. Build + deploy the site

Use the one-command deploy script (details below):

```bash
bash aws/deploy.sh
```

It builds a production bundle, syncs it to the bucket (long cache on hashed
assets, no-cache on `index.html`), and invalidates CloudFront so visitors get
the new version immediately.

---

## 5. Verify

```bash
curl -I https://altioraestudio.com            # expect HTTP/2 200
```

Open the site, test: the chatbot answers, the contact form submits, deep links
(refresh on any scrolled state) don't 404.

---

## Redeploying later

Any time you change the app:

```bash
bash aws/deploy.sh
```

That's the whole loop — build, sync, invalidate.

---

## Notes / hardening later

- **CORS lock-down:** once live, re-run `aws/setup-contact.sh` with
  `ALLOWED_ORIGIN=https://altioraestudio.com` so the contact API only accepts
  your site.
- **www redirect:** this setup serves the site on both apex and www. If you want
  www → apex redirect, add a CloudFront function or a separate redirect
  distribution later.
- **Private bucket (OAC):** this guide uses the public S3 website endpoint
  (matching your current bucket). A more locked-down option is a private bucket
  with CloudFront Origin Access Control. Switchable later.
