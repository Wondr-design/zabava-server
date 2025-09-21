import { kv } from "@vercel/kv";

const META_PREFIX = "partner:meta:";

function buildDefaultPartnerMeta(partnerId) {
  const timestamp = new Date().toISOString();
  return {
    partnerId,
    status: "active",
    contract: {
      monthlyFee: 0,
      discountRate: 0,
      commissionRate: 0,
      commissionBasis: "discounted",
    },
    ticketing: {
      ticketTypes: [],
      familyRule: "",
    },
    info: {
      contactName: "",
      contactEmail: "",
      payments: [],
      facilities: [],
      website: "",
    },
    media: {
      logoUrl: "",
      heroImageUrl: "",
    },
    bonusProgramEnabled: false,
    notes: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function rawGetPartnerMeta(partnerId) {
  const key = `${META_PREFIX}${partnerId}`;
  const value = await kv.get(key);
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (err) {
      console.warn("Failed to parse partner meta JSON for", partnerId, err);
      return null;
    }
  }
  if (typeof value === "object") {
    return value;
  }
  return null;
}

async function loadPartnerMeta(partnerId) {
  const normalizedId = String(partnerId || "").trim().toLowerCase();
  if (!normalizedId) {
    throw new Error("partnerId is required");
  }

  const existing = await rawGetPartnerMeta(normalizedId);
  if (!existing) {
    return buildDefaultPartnerMeta(normalizedId);
  }

  const defaults = buildDefaultPartnerMeta(normalizedId);
  return {
    ...defaults,
    ...existing,
    partnerId: normalizedId,
    contract: {
      ...defaults.contract,
      ...(existing.contract || {}),
    },
    ticketing: {
      ...defaults.ticketing,
      ...(existing.ticketing || {}),
      ticketTypes: Array.isArray(existing?.ticketing?.ticketTypes)
        ? existing.ticketing.ticketTypes
        : [],
    },
    info: {
      ...defaults.info,
      ...(existing.info || {}),
      payments: Array.isArray(existing?.info?.payments)
        ? existing.info.payments
        : [],
      facilities: Array.isArray(existing?.info?.facilities)
        ? existing.info.facilities
        : [],
    },
    media: {
      ...defaults.media,
      ...(existing.media || {}),
    },
    bonusProgramEnabled:
      typeof existing.bonusProgramEnabled === "boolean"
        ? existing.bonusProgramEnabled
        : defaults.bonusProgramEnabled,
    createdAt: existing.createdAt || defaults.createdAt,
    updatedAt: existing.updatedAt || defaults.updatedAt,
  };
}

function mergePartnerMeta(existing, updates) {
  const merged = { ...existing };

  if (updates.status) {
    merged.status = updates.status;
  }

  if (updates.contract) {
    merged.contract = {
      ...existing.contract,
      ...updates.contract,
    };
  }

  if (updates.ticketing) {
    merged.ticketing = {
      ...existing.ticketing,
      ...updates.ticketing,
    };
    if (updates.ticketing.ticketTypes) {
      merged.ticketing.ticketTypes = updates.ticketing.ticketTypes;
    }
  }

  if (updates.info) {
    merged.info = {
      ...existing.info,
      ...updates.info,
    };
    if (updates.info.payments) {
      merged.info.payments = updates.info.payments;
    }
    if (updates.info.facilities) {
      merged.info.facilities = updates.info.facilities;
    }
  }

  if (updates.media) {
    merged.media = {
      ...existing.media,
      ...updates.media,
    };
  }

  if (typeof updates.bonusProgramEnabled === "boolean") {
    merged.bonusProgramEnabled = updates.bonusProgramEnabled;
  }

  if (typeof updates.notes === "string") {
    merged.notes = updates.notes;
  }

  merged.updatedAt = new Date().toISOString();
  return merged;
}

async function savePartnerMeta(partnerId, updates) {
  const normalizedId = String(partnerId || "").trim().toLowerCase();
  if (!normalizedId) {
    throw new Error("partnerId is required");
  }

  const existing = await loadPartnerMeta(normalizedId);
  const merged = mergePartnerMeta(existing, updates || {});
  const key = `${META_PREFIX}${normalizedId}`;
  await kv.set(key, JSON.stringify(merged));
  return merged;
}

async function listPartnerMetas(partnerIds) {
  const items = [];
  for (const id of partnerIds) {
    const meta = await loadPartnerMeta(id);
    items.push(meta);
  }
  items.sort((a, b) => a.partnerId.localeCompare(b.partnerId));
  return items;
}

export {
  buildDefaultPartnerMeta,
  loadPartnerMeta,
  savePartnerMeta,
  listPartnerMetas,
};
