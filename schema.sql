CREATE TABLE IF NOT EXISTS users (
  token TEXT PRIMARY KEY,
  nick TEXT UNIQUE NOT NULL,
  created TEXT NOT NULL
);

-- pick: 0 멀쩡, 1 뻐근, 2 쑤심(=비 온다)
CREATE TABLE IF NOT EXISTS votes (
  day TEXT NOT NULL,
  region TEXT NOT NULL,
  token TEXT NOT NULL,
  pick INTEGER NOT NULL,
  iphash TEXT NOT NULL,
  created TEXT NOT NULL,
  correct INTEGER,
  points INTEGER,
  PRIMARY KEY (day, token)
);
CREATE UNIQUE INDEX IF NOT EXISTS votes_ip1 ON votes (day, iphash);
CREATE UNIQUE INDEX IF NOT EXISTS users_nick ON users (lower(nick));

-- 밤 11시 예보 박제 + 다음날 실제 + 판정
CREATE TABLE IF NOT EXISTS results (
  day TEXT NOT NULL,
  region TEXT NOT NULL,
  fc_pop INTEGER,
  fc_mm REAL,
  fc_rain INTEGER,
  pressure REAL,
  humidity REAL,
  act_mm REAL,
  act_rain INTEGER,
  knee_rain INTEGER,
  votes INTEGER,
  winner TEXT,
  PRIMARY KEY (day, region)
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
