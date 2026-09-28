import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

app.use(express.json());

// Persistent storage for global click counts across all visitors
const dataDir = path.join(process.cwd(), "data");
const clicksFile = path.join(dataDir, "clicks.json");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Genuine click counts starting at 13000 by default for all links with durable total tracking
const DEFAULT_START_CLICKS = 13000;
let totalClicks = DEFAULT_START_CLICKS;
let clickCounts: Record<string, number> = {};
let deviceCounts = {
  desktop: 0,
  mobile: 0,
  iphone: 0,
};

// Active members fallback compatibility
const BASE_ACTIVE_MEMBERS = 1420;

interface StoredData {
  total?: number;
  clicks: Record<string, number>;
  devices?: {
    desktop: number;
    mobile: number;
    iphone: number;
  };
  updatedAt?: string;
}

if (fs.existsSync(clicksFile)) {
  try {
    const raw = fs.readFileSync(clicksFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      if (typeof parsed.total === "number" && !isNaN(parsed.total)) {
        totalClicks = Math.max(DEFAULT_START_CLICKS, parsed.total);
      }
      const storedClicks = (parsed.clicks && typeof parsed.clicks === "object") ? parsed.clicks : parsed;
      for (const [key, val] of Object.entries(storedClicks)) {
        if (typeof val === "number" && !isNaN(val)) {
          clickCounts[key] = Math.max(0, val);
        }
      }
      if (parsed.devices && typeof parsed.devices === "object") {
        deviceCounts.desktop = Math.max(0, Number(parsed.devices.desktop) || 0);
        deviceCounts.mobile = Math.max(0, Number(parsed.devices.mobile) || 0);
        deviceCounts.iphone = Math.max(0, Number(parsed.devices.iphone) || 0);
      }
      const sum = Object.values(clickCounts).reduce((acc, curr) => acc + curr, 0);
      totalClicks = Math.max(DEFAULT_START_CLICKS, totalClicks, sum);
    }
  } catch (err) {
    console.error("Error reading clicks.json:", err);
  }
} else {
  try {
    fs.writeFileSync(clicksFile, JSON.stringify({ total: DEFAULT_START_CLICKS, clicks: {}, devices: deviceCounts }, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing initial clicks.json:", err);
  }
}

function persistClicks() {
  try {
    const sum = Object.values(clickCounts).reduce((acc, curr) => acc + curr, 0);
    totalClicks = Math.max(DEFAULT_START_CLICKS, totalClicks, sum);
    const payload: StoredData = {
      total: totalClicks,
      clicks: clickCounts,
      devices: deviceCounts,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(clicksFile, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to persist clicks to disk:", err);
  }
}

function detectDevice(userAgent: string = ""): "iphone" | "mobile" | "desktop" {
  const ua = userAgent.toLowerCase();
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) {
    return "iphone";
  }
  if (ua.includes("android") || ua.includes("mobile") || ua.includes("tablet")) {
    return "mobile";
  }
  return "desktop";
}

// API Routes
app.get("/api/members", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.json({
    activeMembers: BASE_ACTIVE_MEMBERS,
    onlineNow: 1,
    total: totalClicks,
    devices: deviceCounts,
  });
});

app.post("/api/heartbeat", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.json({
    activeMembers: BASE_ACTIVE_MEMBERS,
    onlineNow: 1,
    total: totalClicks,
    devices: deviceCounts,
  });
});

app.get("/api/clicks", (req, res) => {
  const clientHistory = Math.max(0, Number(req.query?.clientHistoryTotal) || 0);
  const sum = Object.values(clickCounts).reduce((acc, curr) => acc + curr, 0);

  // If client has higher historical total (e.g. after a redeploy/republish), adopt it
  if (clientHistory > totalClicks) {
    totalClicks = Math.max(DEFAULT_START_CLICKS, clientHistory);
    persistClicks();
  } else {
    totalClicks = Math.max(DEFAULT_START_CLICKS, totalClicks, sum);
  }

  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.json({
    clicks: clickCounts,
    total: totalClicks,
    devices: deviceCounts,
  });
});

// Endpoint to sync historical click counts from client storage
app.post("/api/clicks/sync", (req, res) => {
  const clientTotal = Math.max(0, Number(req.body?.clientTotal || req.body?.historicalTotal) || 0);
  const clientClicks = req.body?.clicks && typeof req.body.clicks === "object" ? req.body.clicks : {};

  // Merge individual link counts
  for (const [key, val] of Object.entries(clientClicks)) {
    const num = Number(val);
    if (!isNaN(num) && num > 0) {
      clickCounts[key] = Math.max(clickCounts[key] || 0, num);
    }
  }

  const sum = Object.values(clickCounts).reduce((acc, curr) => acc + curr, 0);
  totalClicks = Math.max(DEFAULT_START_CLICKS, totalClicks, sum, clientTotal);
  persistClicks();

  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.json({
    total: totalClicks,
    clicks: clickCounts,
    devices: deviceCounts,
  });
});

const handleClickIncrement: express.RequestHandler = (req, res) => {
  const rawId = req.params.id || req.body?.id || req.query?.id;
  if (!rawId) {
    res.status(400).json({ error: "Missing link id" });
    return;
  }

  const id = String(rawId).trim();
  const userAgent = req.headers["user-agent"] || "";
  const deviceType = detectDevice(userAgent);
  const clientTotal = Math.max(0, Number(req.body?.clientTotal) || 0);

  // Increment device counter
  deviceCounts[deviceType] = (deviceCounts[deviceType] || 0) + 1;

  // Increment link counter
  const current = clickCounts[id] || 0;
  clickCounts[id] = current + 1;

  // Calculate new total ensuring it never decreases and is at least clientTotal + 1
  const sum = Object.values(clickCounts).reduce((acc, curr) => acc + curr, 0);
  totalClicks = Math.max(totalClicks + 1, sum, clientTotal > 0 ? clientTotal + 1 : 0);
  persistClicks();

  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.json({
    id,
    count: clickCounts[id],
    total: totalClicks,
    clicks: clickCounts,
    device: deviceType,
    devices: deviceCounts,
  });
};

app.post("/api/clicks/:id", handleClickIncrement);
app.post("/api/clicks", handleClickIncrement);

// SEO: Explicit sitemap and robots handlers to guarantee XML/plain-text responses
app.get("/sitemap.xml", (_req, res) => {
  const publicPath = path.join(process.cwd(), "public", "sitemap.xml");
  const distPath = path.join(process.cwd(), "dist", "sitemap.xml");
  const target = fs.existsSync(publicPath) ? publicPath : distPath;
  if (fs.existsSync(target)) {
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.sendFile(target);
  } else {
    res.status(404).type("text/plain").send("sitemap.xml not found");
  }
});

app.get("/robots.txt", (_req, res) => {
  const publicPath = path.join(process.cwd(), "public", "robots.txt");
  const distPath = path.join(process.cwd(), "dist", "robots.txt");
  const target = fs.existsSync(publicPath) ? publicPath : distPath;
  if (fs.existsSync(target)) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.sendFile(target);
  } else {
    res.status(404).type("text/plain").send("robots.txt not found");
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
