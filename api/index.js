import router from "../server/router.js";

export default async function handler(req, res) {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url, `https://${host}`);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  await router(req, res, path);
}
