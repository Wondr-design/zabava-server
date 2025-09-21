import registerHandler from "./routes/register.js";
import verifyHandler from "./routes/verify.js";
import pendingHandler from "./routes/pending.js";
import tildaProxyHandler from "./routes/tilda-proxy.js";
import authLoginHandler from "./routes/auth/login.js";
import authSignupHandler from "./routes/auth/signup.js";
import authProfileHandler from "./routes/auth/profile.js";
import adminAnalyticsHandler from "./routes/admin/analytics.js";
import adminInvitesHandler from "./routes/admin/invites.js";
import adminAccountsHandler from "./routes/admin/accounts.js";
import adminUpdateHandler from "./routes/admin/update.js";
import adminOverviewHandler from "./routes/admin/overview.js";
import adminPartnersHandler from "./routes/admin/partners.js";
import partnerByIdHandler from "./routes/partner/by-id.js";
import partnerVisitHandler from "./routes/partner/visit.js";

const routes = [
  { method: "POST", pattern: /^register$/, handler: registerHandler },
  { method: "GET", pattern: /^verify$/, handler: verifyHandler },
  { method: "GET", pattern: /^pending$/, handler: pendingHandler },
  { method: "POST", pattern: /^pending$/, handler: pendingHandler },
  { method: "GET", pattern: /^tilda-proxy$/, handler: tildaProxyHandler },
  { method: "POST", pattern: /^tilda-proxy$/, handler: tildaProxyHandler },
  { method: "POST", pattern: /^auth\/login$/, handler: authLoginHandler },
  { method: "POST", pattern: /^auth\/signup$/, handler: authSignupHandler },
  { method: "GET", pattern: /^auth\/profile$/, handler: authProfileHandler },
  { method: "GET", pattern: /^admin\/overview$/, handler: adminOverviewHandler },
  { method: "GET", pattern: /^admin\/partners$/, handler: adminPartnersHandler },
  {
    method: "GET",
    pattern: /^admin\/partners\/([^/]+)$/,
    handler: adminPartnersHandler,
    prepare: (req, match) => {
      if (!req.query) req.query = {};
      req.query.partnerId = match[1];
    },
  },
  {
    method: "PUT",
    pattern: /^admin\/partners\/([^/]+)$/,
    handler: adminPartnersHandler,
    prepare: (req, match) => {
      if (!req.query) req.query = {};
      req.query.partnerId = match[1];
    },
  },
  { method: "GET", pattern: /^admin\/analytics$/, handler: adminAnalyticsHandler },
  { method: "GET", pattern: /^admin\/invites$/, handler: adminInvitesHandler },
  { method: "POST", pattern: /^admin\/invites$/, handler: adminInvitesHandler },
  { method: "POST", pattern: /^admin\/accounts$/, handler: adminAccountsHandler },
  { method: "PUT", pattern: /^admin\/accounts$/, handler: adminAccountsHandler },
  { method: "POST", pattern: /^admin\/update$/, handler: adminUpdateHandler },
  {
    method: "GET",
    pattern: /^partner\/([^/]+)$/,
    handler: partnerByIdHandler,
    prepare: (req, match) => {
      if (!req.query) req.query = {};
      req.query.partnerId = match[1];
    },
  },
  {
    method: "POST",
    pattern: /^partner\/visit$/,
    handler: partnerVisitHandler,
  },
];

export default async function router(req, res, rawPath) {
  const path = (rawPath || "").replace(/^\/+|\/+$/g, "");
  if (!req.query) req.query = {};
  if (req.query.route) {
    delete req.query.route;
  }

  for (const route of routes) {
    const match = route.pattern.exec(path);
    if (match) {
      if (req.method === "OPTIONS") {
        route.prepare?.(req, match);
        return route.handler(req, res);
      }
      if (route.method === req.method) {
        route.prepare?.(req, match);
        return route.handler(req, res);
      }
    }
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-admin-secret"
    );
    return res.status(200).end();
  }

  if (req.method === "GET" && path === "") {
    return res.status(200).json({ status: "ok" });
  }

  return res.status(404).json({ error: "Not found" });
}
