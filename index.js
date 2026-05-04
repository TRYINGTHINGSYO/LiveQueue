const { WebcastPushConnection } = require("tiktok-live-connector");
const fetch = require("node-fetch");
const fs = require("fs");

// =====================
// CONFIG
// =====================
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || "fsblaker";
const QUEUE_API_URL = process.env.QUEUE_API_URL || "https://siegequeue.com/api/admin/add";
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

function getUserRecord(users, tiktokUser) {
  const old = users[tiktokUser];

  if (!old) {
    return {
      name: "",
      queued: false
    };
  }

  if (typeof old === "string") {
    return {
      name: old,
      queued: false
    };
  }

  return {
    name: old.name || "",
    queued: Boolean(old.queued)
  };
}

function setUserRecord(users, tiktokUser, record) {
  users[tiktokUser] = {
    name: record.name || "",
    queued: Boolean(record.queued)
  };

  saveUsers(users);
}

// =====================
// NAME CLEANUP
// =====================
function cleanName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 20);
}

// =====================
// ADD TO SIEGEQUEUE
// =====================
async function addToQueue(name, tiktokUser) {
  const clean = cleanName(name);

  if (!clean) {
    console.log(`No valid name for ${tiktokUser}`);
    return {
      ok: false,
      alreadyQueued: false
    };
  }

  if (!ADMIN_PASSWORD) {
    console.error("Missing ADMIN_PASSWORD variable in Railway");
    return {
      ok: false,
      alreadyQueued: false
    };
  }

  try {
    const res = await fetch(QUEUE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-password": ADMIN_PASSWORD,
        "x-admin-secret": ADMIN_PASSWORD,
        authorization: `Bearer ${ADMIN_PASSWORD}`
      },
      body: JSON.stringify({ name: clean })
    });

    const text = await res.text();

    if (!res.ok) {
      console.error(`Failed to add ${clean}: ${res.status} ${text}`);

      if (text.includes("Already in queue or playing")) {
        return {
          ok: false,
          alreadyQueued: true
        };
      }

      return {
        ok: false,
        alreadyQueued: false
      };
    }

    console.log(`Added to queue: ${clean} from TikTok user ${tiktokUser}`);

    return {
      ok: true,
      alreadyQueued: false
    };
  } catch (err) {
    console.error("Failed to add to queue:", err);

    return {
      ok: false,
      alreadyQueued: false
    };
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

  const typedName = message.split(" ").slice(1).join(" ").trim();
  const record = getUserRecord(users, tiktokUser);

  // If this TikTok user already got in, block more names.
  if (record.queued) {
    console.log(
      `${tiktokUser} tried to add another name, but they are already locked as ${record.name}`
    );
    return;
  }

  // First-time name save
  if (typedName) {
    const savedName = cleanName(typedName);

    if (!savedName) {
      console.log(`${tiktokUser} typed an invalid name`);
      return;
    }

    const result = await addToQueue(savedName, tiktokUser);

    if (result.ok || result.alreadyQueued) {
      setUserRecord(users, tiktokUser, {
        name: savedName,
        queued: true
      });

      console.log(`${tiktokUser} is now locked as ${savedName}`);
    }

    return;
  }

  // Using saved name with !q
  if (record.name) {
    const result = await addToQueue(record.name, tiktokUser);

    if (result.ok || result.alreadyQueued) {
      setUserRecord(users, tiktokUser, {
        name: record.name,
        queued: true
      });

      console.log(`${tiktokUser} is now locked as ${record.name}`);
    }

    return;
  }

  console.log(`${tiktokUser} typed !q but has no saved name yet`);
  console.log(`They need to type: !q theirName`);
});

tiktok.on("disconnected", () => {
  console.log("TikTok disconnected. Restart the Railway deployment if needed.");
});

tiktok.on("error", (err) => {
  console.error("TikTok connection error:", err);
});
