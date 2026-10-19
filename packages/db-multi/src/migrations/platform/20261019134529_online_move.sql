--up
-- An online move keeps the tenant writable while its schema is copied by logical replication; a resumed move must know which flow it is in.
ALTER TABLE moves ADD COLUMN online boolean NOT NULL DEFAULT false;

--down
-- Informational only: no command runs platform/node down sections.
ALTER TABLE moves DROP COLUMN online;
