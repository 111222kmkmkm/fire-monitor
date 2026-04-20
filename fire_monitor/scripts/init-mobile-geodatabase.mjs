import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

function parseArgs(argv) {
  const options = {
    out: 'fire_monitor.geodatabase',
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--out') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --out');
      }
      options.out = next;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function ensureParentDirectory(filePath) {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function createDomainTables(db) {
  db.exec(`
    CREATE TABLE domain_fire_status (
      code TEXT PRIMARY KEY,
      description TEXT NOT NULL
    );

    CREATE TABLE domain_daynight (
      code TEXT PRIMARY KEY,
      description TEXT NOT NULL
    );

    CREATE TABLE domain_source_sat (
      code TEXT PRIMARY KEY,
      description TEXT NOT NULL
    );

    INSERT INTO domain_fire_status (code, description) VALUES
      ('suspected', 'Suspected fire point'),
      ('confirmed', 'Confirmed fire point'),
      ('rejected', 'Rejected false alarm');

    INSERT INTO domain_daynight (code, description) VALUES
      ('D', 'Daytime'),
      ('N', 'Nighttime');

    INSERT INTO domain_source_sat (code, description) VALUES
      ('H09', 'Himawari-9'),
      ('SNPP', 'Suomi NPP'),
      ('NOAA20', 'NOAA-20'),
      ('NOAA21', 'NOAA-21');
  `);
}

function createBusinessTables(db) {
  db.exec(`
    CREATE TABLE raw_scene (
      scene_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_sat TEXT NOT NULL REFERENCES domain_source_sat(code),
      satellite TEXT,
      sensor TEXT,
      scene_time_utc TEXT NOT NULL,
      acq_time TEXT,
      band TEXT,
      scene_name TEXT,
      scene_path TEXT NOT NULL UNIQUE,
      roi_name TEXT,
      roi_code TEXT,
      file_path TEXT UNIQUE,
      file_size INTEGER,
      checksum TEXT,
      file_blob BLOB,
      download_time TEXT,
      download_status TEXT,
      projection TEXT,
      checksum_md5 TEXT,
      ingest_status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE raster_asset (
      asset_id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_scene_id INTEGER REFERENCES raw_scene(scene_id) ON DELETE SET NULL,
      file_path TEXT NOT NULL UNIQUE,
      satellite TEXT NOT NULL REFERENCES domain_source_sat(code),
      band TEXT,
      obs_time_utc TEXT NOT NULL,
      roi_name TEXT,
      projection TEXT,
      process_status TEXT NOT NULL DEFAULT 'new',
      checksum_md5 TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE algo_config (
      config_id INTEGER PRIMARY KEY AUTOINCREMENT,
      algo_name TEXT NOT NULL,
      algo_version TEXT NOT NULL,
      threshold_key TEXT NOT NULL,
      threshold_value REAL,
      threshold_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      effective_from_utc TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (algo_name, algo_version, threshold_key)
    );

    CREATE TABLE fetch_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_sat TEXT REFERENCES domain_source_sat(code),
      endpoint TEXT,
      request_time_utc TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      success INTEGER NOT NULL CHECK (success IN (0, 1)),
      http_status INTEGER,
      duration_ms INTEGER,
      message TEXT,
      trace_id TEXT
    );
  `);
}

function createFeatureTables(db) {
  db.exec(`
    CREATE TABLE viirs_fire_nrt (
      objectid INTEGER PRIMARY KEY AUTOINCREMENT,
      source_sat TEXT NOT NULL REFERENCES domain_source_sat(code),
      acq_time_utc TEXT NOT NULL,
      daynight TEXT NOT NULL REFERENCES domain_daynight(code),
      fire_status TEXT NOT NULL DEFAULT 'suspected' REFERENCES domain_fire_status(code),
      confidence REAL,
      brightness REAL,
      frp REAL,
      lon REAL NOT NULL,
      lat REAL NOT NULL,
      geom_wkt TEXT,
      minx REAL NOT NULL,
      maxx REAL NOT NULL,
      miny REAL NOT NULL,
      maxy REAL NOT NULL,
      scene_id INTEGER REFERENCES raw_scene(scene_id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE candidate_fire (
      objectid INTEGER PRIMARY KEY AUTOINCREMENT,
      source_sat TEXT NOT NULL REFERENCES domain_source_sat(code),
      acq_time_utc TEXT NOT NULL,
      daynight TEXT NOT NULL REFERENCES domain_daynight(code),
      fire_status TEXT NOT NULL DEFAULT 'suspected' REFERENCES domain_fire_status(code),
      score REAL,
      bt_tir REAL,
      bt_dif REAL,
      lon REAL NOT NULL,
      lat REAL NOT NULL,
      geom_wkt TEXT,
      minx REAL NOT NULL,
      maxx REAL NOT NULL,
      miny REAL NOT NULL,
      maxy REAL NOT NULL,
      scene_id INTEGER REFERENCES raw_scene(scene_id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE fire_event (
      objectid INTEGER PRIMARY KEY AUTOINCREMENT,
      event_code TEXT UNIQUE,
      source_sat TEXT NOT NULL REFERENCES domain_source_sat(code),
      first_seen_utc TEXT NOT NULL,
      last_seen_utc TEXT,
      daynight TEXT REFERENCES domain_daynight(code),
      fire_status TEXT NOT NULL DEFAULT 'suspected' REFERENCES domain_fire_status(code),
      confidence REAL,
      persistence_count INTEGER,
      lon REAL NOT NULL,
      lat REAL NOT NULL,
      geom_wkt TEXT,
      minx REAL NOT NULL,
      maxx REAL NOT NULL,
      miny REAL NOT NULL,
      maxy REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE static_hot_source (
      objectid INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT,
      source_type TEXT,
      confidence REAL,
      lon REAL NOT NULL,
      lat REAL NOT NULL,
      geom_wkt TEXT,
      minx REAL NOT NULL,
      maxx REAL NOT NULL,
      miny REAL NOT NULL,
      maxy REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE roi_boundary (
      objectid INTEGER PRIMARY KEY AUTOINCREMENT,
      roi_code TEXT UNIQUE,
      roi_name TEXT NOT NULL,
      geom_wkt TEXT NOT NULL,
      minx REAL NOT NULL,
      maxx REAL NOT NULL,
      miny REAL NOT NULL,
      maxy REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE mask_water (
      objectid INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT,
      geom_wkt TEXT NOT NULL,
      minx REAL NOT NULL,
      maxx REAL NOT NULL,
      miny REAL NOT NULL,
      maxy REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE mask_industry (
      objectid INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT,
      priority INTEGER,
      geom_wkt TEXT NOT NULL,
      minx REAL NOT NULL,
      maxx REAL NOT NULL,
      miny REAL NOT NULL,
      maxy REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function createSpatialIndexes(db, tableName) {
  const indexTable = `idx_${tableName}_spatial`;
  db.exec(`
    CREATE VIRTUAL TABLE ${indexTable} USING rtree(
      objectid,
      minx,
      maxx,
      miny,
      maxy
    );

    CREATE TRIGGER ${tableName}_spatial_insert
    AFTER INSERT ON ${tableName}
    BEGIN
      INSERT INTO ${indexTable} (objectid, minx, maxx, miny, maxy)
      VALUES (NEW.objectid, NEW.minx, NEW.maxx, NEW.miny, NEW.maxy);
    END;

    CREATE TRIGGER ${tableName}_spatial_update
    AFTER UPDATE OF minx, maxx, miny, maxy ON ${tableName}
    BEGIN
      UPDATE ${indexTable}
      SET minx = NEW.minx,
          maxx = NEW.maxx,
          miny = NEW.miny,
          maxy = NEW.maxy
      WHERE objectid = NEW.objectid;
    END;

    CREATE TRIGGER ${tableName}_spatial_delete
    AFTER DELETE ON ${tableName}
    BEGIN
      DELETE FROM ${indexTable} WHERE objectid = OLD.objectid;
    END;
  `);
}

function createAttributeIndexes(db) {
  db.exec(`
    CREATE INDEX idx_raw_scene_sat_time ON raw_scene (source_sat, scene_time_utc);
    CREATE INDEX idx_raw_scene_acq_band ON raw_scene (acq_time, band);
    CREATE INDEX idx_raster_asset_obs_time ON raster_asset (obs_time_utc);
    CREATE INDEX idx_raster_asset_status ON raster_asset (process_status);
    CREATE INDEX idx_fetch_log_time ON fetch_log (request_time_utc);

    CREATE INDEX idx_viirs_fire_nrt_time ON viirs_fire_nrt (acq_time_utc);
    CREATE INDEX idx_candidate_fire_time ON candidate_fire (acq_time_utc);
    CREATE INDEX idx_fire_event_first_seen ON fire_event (first_seen_utc);
    CREATE INDEX idx_fire_event_status ON fire_event (fire_status);
  `);
}

function createDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('BEGIN;');
  try {
    createDomainTables(db);
    createBusinessTables(db);
    createFeatureTables(db);
    createSpatialIndexes(db, 'candidate_fire');
    createSpatialIndexes(db, 'viirs_fire_nrt');
    createSpatialIndexes(db, 'fire_event');
    createAttributeIndexes(db);

    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO schema_version (version) VALUES (1);
    `);

    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  } finally {
    db.close();
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = resolve(options.out);

  ensureParentDirectory(outputPath);

  if (existsSync(outputPath)) {
    if (!options.force) {
      throw new Error(`Target already exists: ${outputPath}. Use --force to recreate.`);
    }
    rmSync(outputPath);
  }

  createDatabase(outputPath);
  console.log(`Created database: ${outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
