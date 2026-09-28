-- Runs once, on first start of an empty data volume.
-- `hearth` (dev / full stack) is created by POSTGRES_DB; these are the isolated test databases.
CREATE DATABASE hearth_unit;
CREATE DATABASE hearth_e2e;
