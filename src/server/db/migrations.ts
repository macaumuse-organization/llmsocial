// Append-only. Never edit a migration that has shipped; add a new one.
// Column names are camelCase on purpose: rows map straight onto the shared DTO types.

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE auth_sessions (
    tokenHash TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  );

  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    iv BLOB NOT NULL,
    tag BLOB NOT NULL,
    data BLOB NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    baseUrl TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    apiKeyRef TEXT NOT NULL DEFAULT '',
    temperature REAL,
    maxTokens INTEGER NOT NULL DEFAULT 16000,
    effort TEXT,
    jsonMode INTEGER NOT NULL DEFAULT 1,
    timeoutMs INTEGER NOT NULL DEFAULT 90000,
    priceIn REAL,
    priceOut REAL,
    dailyTokenLimit INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 100,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE personas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    identity TEXT NOT NULL,
    style TEXT NOT NULL DEFAULT '',
    disclosure TEXT NOT NULL,
    commentSignature TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    allowedPlatforms TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    builtin INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    goalType TEXT NOT NULL,
    goal TEXT NOT NULL,
    successCriteria TEXT NOT NULL DEFAULT '',
    facts TEXT NOT NULL DEFAULT '',
    allowedLinks TEXT NOT NULL DEFAULT '[]',
    linkFallback TEXT NOT NULL DEFAULT '',
    allowedPlatforms TEXT NOT NULL DEFAULT '[]',
    skillIds TEXT NOT NULL DEFAULT '[]',
    personaId TEXT REFERENCES personas(id) ON DELETE SET NULL,
    providerIds TEXT NOT NULL DEFAULT '[]',
    mode TEXT NOT NULL DEFAULT 'copilot',
    maxDays INTEGER NOT NULL DEFAULT 7,
    maxTurns INTEGER NOT NULL DEFAULT 30,
    replyDelayMinS INTEGER NOT NULL DEFAULT 8,
    replyDelayMaxS INTEGER NOT NULL DEFAULT 25,
    followupEnabled INTEGER NOT NULL DEFAULT 0,
    followupAfterH INTEGER NOT NULL DEFAULT 24,
    followupMax INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    connector TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    secretRefs TEXT NOT NULL DEFAULT '{}',
    personaId TEXT REFERENCES personas(id) ON DELETE SET NULL,
    defaultCampaignId TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active',
    statusDetail TEXT NOT NULL DEFAULT '',
    quietStart TEXT NOT NULL DEFAULT '23:00',
    quietEnd TEXT NOT NULL DEFAULT '08:00',
    timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    maxPerHour INTEGER NOT NULL DEFAULT 30,
    maxPerDay INTEGER NOT NULL DEFAULT 200,
    maxPerContactDay INTEGER NOT NULL DEFAULT 20,
    pollIntervalS INTEGER NOT NULL DEFAULT 120,
    lastPolledAt INTEGER,
    cursor TEXT NOT NULL DEFAULT '{}',
    failures INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    platformUserId TEXT NOT NULL,
    displayName TEXT NOT NULL DEFAULT '',
    handle TEXT NOT NULL DEFAULT '',
    avatarUrl TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    facts TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '',
    summarizedCount INTEGER NOT NULL DEFAULT 0,
    optedOut INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    UNIQUE (accountId, platformUserId)
  );

  -- People who asked not to be contacted. Survives deleting the contact, and applies across accounts.
  CREATE TABLE suppressions (
    platform TEXT NOT NULL,
    platformUserId TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL,
    PRIMARY KEY (platform, platformUserId)
  );

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    contactId TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    campaignId TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'dm',
    threadRef TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    modeOverride TEXT,
    state TEXT NOT NULL DEFAULT 'active',
    stateReason TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT 'new',
    goalProgress INTEGER NOT NULL DEFAULT 0,
    lastAnalysis TEXT,
    unread INTEGER NOT NULL DEFAULT 0,
    aiTurns INTEGER NOT NULL DEFAULT 0,
    followupsSent INTEGER NOT NULL DEFAULT 0,
    lastInboundAt INTEGER,
    lastOutboundAt INTEGER,
    lastMessageAt INTEGER,
    deadlineAt INTEGER,
    disclosedAt INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    UNIQUE (accountId, contactId, kind, threadRef)
  );
  CREATE INDEX ix_conversations_recent ON conversations (lastMessageAt DESC);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    accountId TEXT NOT NULL,
    direction TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    platformMsgId TEXT,
    replyToRef TEXT,
    status TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    approved INTEGER NOT NULL DEFAULT 0,
    reviewReason TEXT NOT NULL DEFAULT '',
    sendAt INTEGER,
    sentAt INTEGER,
    error TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    llmCallId TEXT,
    batchId TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX ix_messages_conversation ON messages (conversationId, createdAt);
  CREATE INDEX ix_messages_status ON messages (status, sendAt);
  -- Webhooks retry and polls overlap: the same platform message must never be stored twice.
  CREATE UNIQUE INDEX ux_messages_platform ON messages (accountId, platformMsgId) WHERE platformMsgId IS NOT NULL;

  CREATE TABLE llm_calls (
    id TEXT PRIMARY KEY,
    conversationId TEXT,
    purpose TEXT NOT NULL,
    providerId TEXT,
    providerName TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    systemPrompt TEXT NOT NULL DEFAULT '',
    userPrompt TEXT NOT NULL DEFAULT '',
    rawResponse TEXT NOT NULL DEFAULT '',
    ok INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    inputTokens INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0,
    cacheReadTokens INTEGER NOT NULL DEFAULT 0,
    latencyMs INTEGER NOT NULL DEFAULT 0,
    costUsd REAL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX ix_llm_calls_conversation ON llm_calls (conversationId, createdAt);
  CREATE INDEX ix_llm_calls_created ON llm_calls (createdAt);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    accountId TEXT,
    conversationId TEXT,
    messageId TEXT,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX ix_events_conversation ON events (conversationId, id);
  CREATE INDEX ix_events_ts ON events (ts);

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    dedupeKey TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    runAt INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    maxAttempts INTEGER NOT NULL DEFAULT 3,
    lastError TEXT NOT NULL DEFAULT '',
    lockedAt INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX ix_jobs_due ON jobs (status, runAt);
  CREATE UNIQUE INDEX ux_jobs_dedupe ON jobs (dedupeKey) WHERE dedupeKey IS NOT NULL AND status IN ('pending', 'running');

  CREATE TABLE sim_runs (
    id TEXT PRIMARY KEY,
    campaignId TEXT NOT NULL,
    agentProviderId TEXT,
    contactProviderId TEXT,
    persona TEXT NOT NULL,
    maxTurns INTEGER NOT NULL,
    status TEXT NOT NULL,
    conversationId TEXT,
    report TEXT,
    error TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE campaigns ADD COLUMN materials TEXT NOT NULL DEFAULT '[]';
  `,
];
