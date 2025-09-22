# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Architecture

This is a serverless Node.js API built for Vercel, serving as the backend for a QR code registration and partner management system for the Zabava platform. The architecture follows a serverless pattern with centralized routing.

### Core Components

- **Entry Point**: `api/index.js` - Main Vercel serverless handler
- **Router**: `server/router.js` - Centralized request routing with regex patterns
- **Routes**: `server/routes/` - Modular endpoint handlers organized by domain
- **Data Layer**: `lib/` - Utility modules for data operations using Vercel KV
- **Storage**: Vercel KV (Redis-compatible key-value store)

### Data Architecture

The system uses Vercel KV with the following key patterns:
- `qr:email:{email}` - Individual QR registration records (hash)
- `partner:{partnerId}` - Set of emails associated with a partner
- `partners` - Set of all partner IDs
- `partner:meta:{partnerId}` - Partner metadata and configuration
- `partnerUser:{email}` - User accounts for partner dashboard access

### Route Organization

Routes are organized by domain:
- **Core Registration**: `register.js`, `verify.js`, `pending.js`
- **Authentication**: `auth/login.js`, `auth/signup.js`, `auth/profile.js`
- **Partner Management**: `partner/by-id.js`, `partner/visit.js`
- **Admin Functions**: `admin/overview.js`, `admin/partners.js`, etc.
- **Integration**: `tilda-proxy.js` for Tilda form integration

## Development Commands

### Deployment
```bash
# Deploy to production
vercel --prod

# Deploy to preview
vercel
```

### Local Development
```bash
# Install dependencies
npm install

# The project uses serverless functions, so local development typically involves:
# - Testing individual route handlers
# - Using Vercel CLI for local simulation
vercel dev
```

### Testing Endpoints
```bash
# Test health check
curl https://zabava-server.vercel.app/api/

# Test registration (POST)
curl -X POST https://zabava-server.vercel.app/api/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","partner_id":"LZ001"}'

# Test partner data (GET)
curl https://zabava-server.vercel.app/api/partner/LZ001
```

## Code Patterns

### Route Handler Pattern
All route handlers follow this structure:
```javascript
export default async function handler(req, res) {
  // Set CORS headers
  setCors(res);
  
  // Handle OPTIONS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  
  // Method validation
  if (req.method !== "EXPECTED_METHOD") {
    return respond(res, 405, { error: "Method Not Allowed" });
  }
  
  try {
    // Business logic
    // Return response
  } catch (error) {
    // Error handling
    return respond(res, 500, { error: "Internal server error" });
  }
}
```

### Data Access Pattern
- Use `kv` from `@vercel/kv` for all storage operations
- Normalize partner IDs to lowercase: `String(partnerId).trim().toLowerCase()`
- Email normalization: `String(email).trim().toLowerCase()`
- Always handle KV operation failures gracefully

### Authentication Pattern
Two auth methods are supported:
1. **Admin Secret**: `x-admin-secret` header matching `ADMIN_SECRET` env var
2. **JWT Bearer Token**: For partner users, validated against `JWT_SECRET`

## Environment Variables

Required for deployment:
- `BASE_URL` - Server base URL
- `ZAPIER_HOOK` - Zapier webhook for notifications
- `ZAPIER_CATCH_HOOK` - Zapier catch hook for Tilda integration
- `ADMIN_SECRET` - Secret for admin endpoints
- `JWT_SECRET` - Secret for JWT token signing/verification
- `ALLOWED_ORIGIN` - CORS allowed origin (default: "*")

Optional:
- `ERROR_WEBHOOK_URL` - For error notifications
- `JWT_EXPIRES_IN` - JWT expiration time (default: "12h")

## Data Models

### Registration Record
```javascript
{
  email: "user@example.com",
  partnerId: "lz001", // normalized
  used: "false", // string boolean
  visited: "false", // string boolean
  payload: "...", // JSON string of form data
  createdAt: "2025-01-01T00:00:00.000Z",
  scannedAt: "", // when QR was scanned
  visitedAt: "", // when partner was visited
}
```

### Partner Metadata
```javascript
{
  partnerId: "lz001",
  status: "active", // active|pending|inactive
  contract: { monthlyFee, discountRate, commissionRate, commissionBasis },
  ticketing: { ticketTypes: [], familyRule: "" },
  info: { contactName, contactEmail, payments: [], facilities: [], website },
  media: { logoUrl, heroImageUrl },
  bonusProgramEnabled: false,
  notes: "",
  createdAt: "...",
  updatedAt: "..."
}
```

## Common Operations

### Adding New Route
1. Create handler in `server/routes/` with appropriate subdirectory
2. Import handler in `server/router.js`
3. Add route pattern to `routes` array with method, regex pattern, and handler
4. For parameterized routes, use `prepare` function to extract params into `req.query`

### Data Validation
- Use `zod` for request validation in auth and admin routes
- Validate email format and required fields in registration
- Always sanitize and normalize input data

### Partner Data Operations
- Use `lib/partner-data.js` for fetching partner metrics and submissions
- Use `lib/partner-meta.js` for partner configuration management
- Partner IDs are case-insensitive (stored lowercase)

## Integration Points

### Tilda Forms
- `tilda-proxy.js` handles form submissions from Tilda
- Forwards data to Zapier webhook (`ZAPIER_CATCH_HOOK`)
- Maintains CORS for cross-origin form submissions

### Zapier Integration  
- Registration events trigger `ZAPIER_HOOK` webhook
- Error notifications use `ERROR_WEBHOOK_URL` if configured
- Partner visit events can trigger custom webhooks

## Security Considerations

- All endpoints support CORS preflight requests
- Admin endpoints require authentication (secret or JWT)
- Input validation prevents malicious data injection  
- Sensitive operations log errors without exposing internals
- Email addresses and partner IDs are normalized to prevent duplicates

## Serverless Constraints

- Each function has execution time limits (Vercel: 10s for Hobby, 60s for Pro)
- Cold starts affect initial response times
- State must be stored externally (Vercel KV)
- Environment variables are managed through Vercel dashboard
- Routes are handled by single entry point (`api/index.js`) due to rewrite rule