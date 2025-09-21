# Zabava Server API

A Vercel-based serverless API for QR code registration and partner management.

## 🚀 **API Endpoints**

### Core Registration

- **POST** `/api/register` - Register new QR code entries
- **GET** `/api/verify` - Verify and mark QR codes as used
- **POST** `/api/pending` - Store pending verification data

### Partner Management

- **GET** `/api/partner/{partnerId}` - Get partner dashboard data
- **GET** `/api/dashboard` - General dashboard with partner listings

### Admin & Utilities

- **POST** `/api/admin/update` - Admin endpoint to update records
- **POST** `/api/tilda-proxy` - Tilda form integration proxy

## 📊 **Data Structure**

### Registration Data

```json
{
  "email": "user@example.com",
  "partner_id": "LZ001",
  "Categories": "School",
  "Age": "18+",
  "Transport": "Yes",
  "Bus_Rental": "Bus D",
  "ticket": "Family",
  "numPeople": "10",
  "preferredDateTime": "2025-11-12T11:00",
  "cityCode": "OLO",
  "privacy": "yes",
  "promo": "yes",
  "totalPrice": 2000,
  "estimatedPoints": 20,
  "selectedBus": "Bus D"
}
```

### Partner Dashboard Response

```json
{
  "submissions": [...],
  "metrics": {
    "count": 3,
    "used": 0,
    "unused": 3,
    "revenue": 2680,
    "points": 26,
    "bonusRedemptions": 0,
    "averageRevenue": 893,
    "averagePoints": 9
  },
  "partner": "LZ001",
  "lastUpdated": "2025-09-17T00:25:27.739Z"
}
```

## 🔧 **Environment Variables**

- `BASE_URL` - Your server base URL
- `ZAPIER_HOOK` - Zapier webhook URL for notifications
- `ZAPIER_CATCH_HOOK` - Zapier catch hook for Tilda integration
- `ADMIN_SECRET` - Secret for admin endpoints
- `ALLOWED_ORIGIN` - CORS allowed origin (default: "\*")

## 🚀 **Deployment**

Deploy to Vercel:

```bash
vercel --prod
```

## 📱 **Partner Dashboards**

This server provides APIs for partner dashboards. Create separate React projects for each partner dashboard using the centralized API endpoints.

### Example Usage

```javascript
// Fetch partner data
const response = await fetch(
  "https://zabava-server.vercel.app/api/partner/LZ001"
);
const data = await response.json();
```

## 🔒 **Security**

- CORS configured for cross-origin requests
- Admin endpoints require authentication
- Input validation and sanitization
- Error handling with proper HTTP status codes

## 📝 **Development**

1. Install dependencies: `npm install`
2. Deploy to Vercel: `vercel --prod`
3. Test endpoints using the provided URLs

## 🎯 **Features**

- ✅ QR code registration and verification
- ✅ Partner-specific data management
- ✅ Real-time metrics and analytics
- ✅ Tilda form integration
- ✅ Zapier webhook support
- ✅ Admin management tools
- ✅ CORS support for frontend integration
# zabava-server
