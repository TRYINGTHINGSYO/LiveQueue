const { WebcastPushConnection } = require("tiktok-live-connector");
const fetch = require("node-fetch");
const fs = require("fs");

// =====================
// CONFIG
// =====================
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || "fsblaker";
const QUEUE_API_URL = process.env.QUEUE_API_URL || "https://siegequeue.com/api/admin/add";

// This looks for ADMIN_PASSWORD first, then ADMIN_SECRET
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_SECRET || "";

const DATA_FILE = "./users.json";

// =====================
// SAVED USERNAMES
// =====================
function loadUsers() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch (err) {
    console.error("Could not load users.json:", err);
  }

  return {};
}

function saveUsers(users) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error("Could not save users.json:", err);
  }
}

// =====================
// NAME CLEANUP
// =====================
function cleanName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 20);
}

// =====================
// ADD TO SIEGEQUEUE
// =====================
async function addToQueue(name, tiktokUser) {
  const clean = cleanName(name);

  if (!clean) {
    console.log(`No valid name for ${tiktokUser}`);
    return;
  }

  if (!ADMIN_PASSWORD) {
    console.error("Missing ADMIN_PASSWORD variable in Railway");
    return;
  }

  try {
    const res = await fetch(QUEUE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-password": ADMIN_PASSWORD,
        "x-admin-secret": ADMIN_PASSWORD,
        "authorization": `Bearer ${ADMIN_PASSWORD}`
      },
      body: JSON.stringify({ name: clean })
    });

    const text = await res.text();

    if (!res.ok) {
      console.error(`Failed to add ${clean}: ${res.status} ${text}`);
      return;
    }

    console.log(`Added to queue: ${clean} from TikTok user ${tiktokUser}`);
  } catch (err) {
    console.error("Failed to add to queue:", err);
  }
}

// =====================
// MAIN BOT
// =====================
const users = loadUsers();
const tiktok = new WebcastPushConnection(TIKTOK_USERNAME);

tiktok
  .connect()
  .then(() => {
    console.log(`Connected to TikTok Live for @${TIKTOK_USERNAME}`);
    console.log("Commands:");
    console.log("!q Blake");
    console.log("!q");
  })
  .catch((err) => {
    console.error("Failed to connect to TikTok Live:", err);
  });

tiktok.on("chat", async (data) => {
  const tiktokUser = data.uniqueId;
  const rawMessage = data.comment || "";
  const message = rawMessage.trim();

  if (!message.toLowerCase().startsWith("!q")) return;

  const parts = message.split(" ");
  const typedName = parts.slice(1).join(" ").trim();

  if (typedName) {
    const savedName = cleanName(typedName);

    users[tiktokUser] = savedName;
    saveUsers(users);

    console.log(`${tiktokUser} saved name as ${savedName}`);
    await addToQueue(savedName, tiktokUser);
    return;
  }

  const savedName = users[tiktokUser];

  if (savedName) {
    console.log(`${tiktokUser} used saved name ${savedName}`);
    await addToQueue(savedName, tiktokUser);
    return;
  }

  console.log(`${tiktokUser} typed !q but has no saved name yet`);
  console.log(`They need to type: !q theirName`);
});
