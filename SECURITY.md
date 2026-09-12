# Security Policy

Thanks for helping keep `yuurei` safe. This project bridges credentials into
isolated runtime environments, so reports are taken seriously even though the
project is pre-1.0.

## Reporting a vulnerability

Please report vulnerabilities **privately** by creating a draft security
advisory on GitHub:

https://github.com/shimpeiws/yuurei/security/advisories/new

Use the "Report a vulnerability" flow under the repository's Security tab. Do
not file public issues for suspected security problems.

## What to include

- The `yuurei` version or commit you tested against
- Steps to reproduce, or a minimal proof of concept
- Impact, if you know it (what an attacker could do)
- Whether the issue affects the credential bridge, isolation, or the trace

## What to expect

Reports are acknowledged within 3 business days. You will get an initial
assessment of validity and severity, then updates as the issue is worked.
Patch timelines are not promised in advance.

## Supported versions

Security fixes are made for the **latest published release** only. Development
on `main` is not itself a supported version. If you cannot upgrade, keep the
`yuurei` version current when it runs untrusted content.

## Do not post details publicly

Never post credentials, tokens, API keys, private repository contents, or
exploit details in public issues, discussions, or pull requests. If you are
unsure whether something is sensitive, route it through the private advisory
flow above in full.

## Maintainer-side review

Internal review happens per the [security review policy](docs/security/review-policy.md).
