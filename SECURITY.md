# Security Policy — PowPow

## Reporting a Vulnerability

If you discover a security vulnerability in PowPow, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, contact the maintainer directly.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅ Yes     |

## Security Design

PowPow follows a secure-by-default approach:

- Gateway token authentication is required for all API access
- All tool executions require explicit approval (configurable)
- Channel access is restricted via allowlists
- File system access is sandboxed and audited
- Sensitive values are redacted from logs

## Best Practices

1. Always set a strong `POWPOW_GATEWAY_TOKEN`
2. Do not expose the gateway port publicly without authentication
3. Use Docker secrets for sensitive values in containerized deployments
4. Regularly rotate API keys
