"""Back up, stage and atomically upsert a converted GeoNames snapshot.

Run with a Python environment containing psycopg 3. On Windows --pg-root can
point to the PostgreSQL installation used by pgAdmin's bundled Python.
The archive remains until --finalize validates the database and API checks.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WORKSPACE = REPO.parent
PCOLS = ['geoname_id','kind','canonical_name','ascii_name','country_code','country_name',
         'admin1_code','admin1_name','feature_code','longitude','latitude','population',
         'importance','source_modified_on','admin2_code','admin3_code','admin4_code']
NCOLS = ['place_id','name','normalized_name','priority']
ATTR = PCOLS[1:]
ADVISORY_KEY = 746293104861

def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + '\n', 'utf-8')

def one(conn, sql, params=None):
    return conn.execute(sql, params).fetchone()[0]

def row(alias, cols):
    return 'ROW(' + ','.join(alias + '.' + c for c in cols) + ')'

def assert_zero(conn, sql, label):
    count = one(conn, sql)
    if count:
        raise RuntimeError(f'{label}: {count} mismatches')
    return count

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=WORKSPACE / 'data/geonames/global-converted-20261029-v1')
    parser.add_argument('--report-dir', type=Path, required=True)
    parser.add_argument('--pg-root', type=Path, default=Path(r'F:\cjy\APP\AppResearch\PostgreSQL\17'))
    parser.add_argument('--finalize', action='store_true')
    args = parser.parse_args()
    pg_root = args.pg_root.resolve()
    dll_handles = []
    if os.name == 'nt':
        dll_handles = [os.add_dll_directory(str(pg_root / 'bin')), os.add_dll_directory(str(pg_root / 'pgAdmin 4/runtime'))]
        os.environ['PATH'] = str(pg_root / 'bin') + os.pathsep + os.environ['PATH']
    import psycopg
    from psycopg import sql
    source, out = args.source.resolve(), args.report_dir.resolve()
    # Keep all operation artifacts within the project's work directory.
    out.relative_to((WORKSPACE / 'work/geonames').resolve())
    report_path = out / 'merge-report.json'
    backup = out / 'before-merge.dump'
    password = (REPO / 'infra/db-password.local').read_text('utf-8').strip()
    config = dict(host='127.0.0.1', port=55432, dbname='digitalearth', user='digitalearth',
                  password=password, connect_timeout=10, application_name='gazetteer-preserving-merge', autocommit=True)
    with psycopg.connect(**config) as conn:
        if args.finalize:
            report = json.loads(report_path.read_text('utf-8'))
            checks = json.loads((out / 'application-checks.json').read_text('utf-8'))
            if report['status'] != 'database_verified_awaiting_application_checks' or not checks['passed']:
                raise RuntimeError('Database and application verification must pass before deleting backup')
            conn.execute('BEGIN READ ONLY')
            try:
                counts = conn.execute('SELECT (SELECT count(*) FROM gazetteer.places),(SELECT count(*) FROM gazetteer.names)').fetchone()
                snapshot = conn.execute('SELECT dataset,source_digest,place_count,name_count FROM gazetteer.snapshot WHERE singleton').fetchone()
                if list(counts) != report['final_counts'] or list(snapshot) != report['final_snapshot']:
                    raise RuntimeError('Database changed since verification; backup retained')
            finally:
                conn.execute('ROLLBACK')
            if not backup.is_file() or backup.stat().st_size != report['backup']['bytes']:
                raise RuntimeError('Expected backup is missing or was changed')
            backup.unlink()
            report['backup']['deleted_after_verification'] = True
            report['status'] = 'completed'
            report['completed_at'] = datetime.now(timezone.utc).isoformat()
            save(report_path, report)
            print(json.dumps({'status':report['status'],'backup_deleted':True,'counts':counts}), flush=True)
            return

        out.mkdir(parents=True, exist_ok=False)
        report = {'status':'preparing','started_at':datetime.now(timezone.utc).isoformat(),
                  'source':str(source),'policy':{'places':'union of IDs; incoming attributes replace existing attributes',
                  'names':'union of (place_id,normalized_name); incoming display name and priority replace existing values',
                  'coordinates_and_population':'incoming source values', 'delete_old_records':False}}
        def stage(name, **values):
            report['stage'] = name
            report.update(values)
            save(report_path,report)
            print(json.dumps({'stage':name, **values},ensure_ascii=False,default=str),flush=True)
        try:
            meta = json.loads((source / 'conversion-report.json').read_text('utf-8'))
            verified = json.loads((source / 'verification-report.json').read_text('utf-8'))
            fmt = json.loads((source / 'csv-format.json').read_text('utf-8'))
            if not verified['passed'] or fmt['places_columns'] != PCOLS or fmt['names_columns'] != NCOLS:
                raise RuntimeError('Source verification or CSV column contract failed')
            if not one(conn,'SELECT pg_try_advisory_lock(%s)',(ADVISORY_KEY,)):
                raise RuntimeError('Another gazetteer import is in progress')
            # Docker's default /dev/shm is 64 MiB. Parallel hash joins can exhaust
            # that segment even when ordinary database RAM is plentiful.
            conn.execute("SET work_mem='64MB'; SET maintenance_work_mem='256MB'; SET max_parallel_workers_per_gather=0; SET statement_timeout=0; SET lock_timeout='30s'")
            stage('backup_consistent_snapshot')
            conn.execute('BEGIN ISOLATION LEVEL REPEATABLE READ')
            old_columns = {r[0] for r in conn.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='gazetteer' AND table_name='places'")}
            old_select = ','.join(c if c in old_columns else 'NULL::text AS '+c for c in PCOLS)
            conn.execute('CREATE TEMP TABLE old_places ON COMMIT PRESERVE ROWS AS SELECT '+old_select+' FROM gazetteer.places')
            conn.execute('CREATE TEMP TABLE old_names ON COMMIT PRESERVE ROWS AS SELECT * FROM gazetteer.names')
            old_counts = conn.execute('SELECT (SELECT count(*) FROM old_places),(SELECT count(*) FROM old_names)').fetchone()
            report['old_counts'] = list(old_counts)
            report['old_snapshot'] = conn.execute('SELECT * FROM gazetteer.snapshot').fetchall()
            foreign_keys = conn.execute("SELECT conname,pg_get_constraintdef(oid,true),convalidated FROM pg_constraint WHERE conrelid='gazetteer.names'::regclass AND contype='f'").fetchall()
            if len(foreign_keys) != 1 or not foreign_keys[0][2]:
                raise RuntimeError('Expected one validated name-to-place foreign key')
            report['foreign_keys'] = foreign_keys
            exported_snapshot = one(conn,'SELECT pg_export_snapshot()')
            env = os.environ.copy()
            env.update(PGHOST='127.0.0.1',PGPORT='55432',PGDATABASE='digitalearth',PGUSER='digitalearth',PGPASSWORD=password)
            suffix = '.exe' if os.name == 'nt' else ''
            def run_pg(program, arguments):
                result = subprocess.run([str(pg_root / 'bin' / (program+suffix)), *arguments],env=env,capture_output=True)
                if result.returncode:
                    raise RuntimeError(program+' failed: '+result.stderr.decode('utf-8',errors='replace'))
                return result.stdout
            run_pg('pg_dump',['--format=custom','--snapshot='+exported_snapshot,'--file='+str(backup)])
            toc = run_pg('pg_restore',['--list',str(backup)])
            if not all(table.encode() in toc for table in ('places','names','snapshot')):
                raise RuntimeError('Backup does not contain required tables')
            # Read/decompress the entire archive with PostgreSQL's own restore tool.
            run_pg('pg_restore',['--file='+os.devnull,str(backup)])
            (out / 'backup-contents.txt').write_bytes(toc)
            report['backup'] = {'path':str(backup),'bytes':backup.stat().st_size,
                                'archive_full_read_passed':True,'deleted_after_verification':False}
            conn.execute('COMMIT')
            stage('load_staging_tables',old_counts=list(old_counts),backup=report['backup'])
            conn.execute('''CREATE TEMP TABLE source_places (
                geoname_id bigint,kind text,canonical_name text,ascii_name text,country_code text,country_name text,
                admin1_code text,admin1_name text,feature_code text,longitude double precision,latitude double precision,
                population bigint,importance smallint,source_modified_on date,admin2_code text,admin3_code text,admin4_code text);
                CREATE TEMP TABLE source_names (place_id bigint,name text,normalized_name text COLLATE "C",priority smallint);''')
            for table in ('places','names'):
                copied = 0
                start = time.monotonic()
                with (source / (table+'.csv')).open('rb') as f, conn.cursor().copy(
                    "COPY source_"+table+" FROM STDIN WITH (FORMAT CSV, NULL E'\\\\N', ENCODING 'UTF8')") as copy:
                    for block in iter(lambda:f.read(4*1024*1024),b''):
                        copy.write(block)
                        copied += len(block)
                stage('staged_'+table,**{table+'_copy_bytes':copied,table+'_copy_seconds':round(time.monotonic()-start,2)})
            stage('validate_staging')
            conn.execute('ALTER TABLE source_places ADD PRIMARY KEY(geoname_id); ALTER TABLE source_names ADD PRIMARY KEY(place_id,normalized_name); ANALYZE source_places; ANALYZE source_names; ANALYZE old_places; ANALYZE old_names')
            source_counts = conn.execute('SELECT (SELECT count(*) FROM source_places),(SELECT count(*) FROM source_names)').fetchone()
            if tuple(source_counts) != (meta['counts']['output_places'],meta['counts']['output_names']):
                raise RuntimeError('Staging row count mismatch')
            assert_zero(conn,'SELECT count(*) FROM source_names n LEFT JOIN source_places p ON p.geoname_id=n.place_id WHERE p.geoname_id IS NULL','Staging orphan names')
            p_overlap,p_shared_changes,p_all_changes = conn.execute('SELECT count(*),count(*) FILTER(WHERE '+row('s',ATTR[:13])+' IS DISTINCT FROM '+row('o',ATTR[:13])+'),count(*) FILTER(WHERE '+row('s',ATTR)+' IS DISTINCT FROM '+row('o',ATTR)+') FROM source_places s JOIN old_places o USING(geoname_id)').fetchone()
            n_overlap,n_changes = conn.execute('SELECT count(*),count(*) FILTER(WHERE ROW(s.name,s.priority) IS DISTINCT FROM ROW(o.name,o.priority)) FROM source_names s JOIN old_names o ON s.place_id=o.place_id AND s.normalized_name=o.normalized_name').fetchone()
            expected = [source_counts[0]+old_counts[0]-p_overlap,source_counts[1]+old_counts[1]-n_overlap]
            report['difference'] = {'source_counts':list(source_counts),'place_overlap':p_overlap,
                'place_additions':source_counts[0]-p_overlap,'place_shared_attribute_changes':p_shared_changes,
                'place_updates_including_new_columns':p_all_changes,'old_only_places_preserved':old_counts[0]-p_overlap,
                'name_overlap':n_overlap,'name_additions':source_counts[1]-n_overlap,'name_attribute_changes':n_changes,
                'old_only_names_preserved':old_counts[1]-n_overlap,'expected_final_counts':expected}
            stage('atomic_merge',difference=report['difference'])
            conn.execute('BEGIN')
            conn.execute('LOCK TABLE gazetteer.places,gazetteer.names,gazetteer.snapshot IN SHARE ROW EXCLUSIVE MODE')
            conn.execute('''ALTER TABLE gazetteer.places
                ADD COLUMN IF NOT EXISTS admin2_code text,ADD COLUMN IF NOT EXISTS admin3_code text,ADD COLUMN IF NOT EXISTS admin4_code text;
                ALTER TABLE gazetteer.places DROP CONSTRAINT IF EXISTS places_kind_check;
                ALTER TABLE gazetteer.places ADD CONSTRAINT places_kind_check CHECK(kind IN('country','admin1','admin2','admin3','admin4','admin5','city'));
                DROP INDEX gazetteer.names_prefix_idx;
                DROP INDEX gazetteer.places_rank_idx;''')
            # Recreate and fully validate the same FK before commit. The tables
            # are exclusively locked by this transaction, so no unvalidated
            # intermediate state is visible and rollback restores the old FK.
            for name, definition, validated in foreign_keys:
                conn.execute(sql.SQL('ALTER TABLE gazetteer.names DROP CONSTRAINT {}').format(sql.Identifier(name)))
            places_sql = ('INSERT INTO gazetteer.places AS p ('+','.join(PCOLS)+') SELECT '+','.join(PCOLS)+
                ' FROM source_places ORDER BY geoname_id ON CONFLICT(geoname_id) DO UPDATE SET '+
                ','.join(c+'=EXCLUDED.'+c for c in ATTR)+' WHERE '+row('p',ATTR)+' IS DISTINCT FROM '+row('EXCLUDED',ATTR))
            report['place_rows_written'] = conn.execute(places_sql).rowcount
            stage('places_merged',place_rows_written=report['place_rows_written'])
            report['name_rows_written'] = conn.execute('''INSERT INTO gazetteer.names AS n (place_id,name,normalized_name,priority)
                SELECT place_id,name,normalized_name,priority FROM source_names ORDER BY place_id,normalized_name
                ON CONFLICT(place_id,normalized_name) DO UPDATE SET name=EXCLUDED.name,priority=EXCLUDED.priority
                WHERE ROW(n.name,n.priority) IS DISTINCT FROM ROW(EXCLUDED.name,EXCLUDED.priority)''').rowcount
            stage('rebuild_search_indexes',name_rows_written=report['name_rows_written'])
            conn.execute('''CREATE INDEX names_prefix_idx ON gazetteer.names(normalized_name text_pattern_ops,priority,place_id) INCLUDE(name);
                CREATE INDEX places_rank_idx ON gazetteer.places(importance,population DESC,geoname_id);
                ANALYZE gazetteer.places; ANALYZE gazetteer.names''')
            for name, definition, validated in foreign_keys:
                conn.execute(sql.SQL('ALTER TABLE gazetteer.names ADD CONSTRAINT {} ').format(sql.Identifier(name)) + sql.SQL(definition))
            stage('validate_merged_data_before_commit')
            checks = {}
            checks['source_place_mismatches'] = assert_zero(conn,'SELECT count(*) FROM source_places s LEFT JOIN gazetteer.places p USING(geoname_id) WHERE p.geoname_id IS NULL OR '+row('s',ATTR)+' IS DISTINCT FROM '+row('p',ATTR),'Incoming place attributes')
            checks['source_name_mismatches'] = assert_zero(conn,'SELECT count(*) FROM source_names s LEFT JOIN gazetteer.names n ON n.place_id=s.place_id AND n.normalized_name=s.normalized_name WHERE n.place_id IS NULL OR ROW(s.name,s.priority) IS DISTINCT FROM ROW(n.name,n.priority)','Incoming name attributes')
            checks['old_place_ids_lost'] = assert_zero(conn,'SELECT count(*) FROM old_places o LEFT JOIN gazetteer.places p USING(geoname_id) WHERE p.geoname_id IS NULL','Preserved old places')
            checks['old_name_keys_lost'] = assert_zero(conn,'SELECT count(*) FROM old_names o LEFT JOIN gazetteer.names n ON n.place_id=o.place_id AND n.normalized_name=o.normalized_name WHERE n.place_id IS NULL','Preserved old names')
            checks['old_only_places_changed'] = assert_zero(conn,'SELECT count(*) FROM old_places o JOIN gazetteer.places p USING(geoname_id) LEFT JOIN source_places s USING(geoname_id) WHERE s.geoname_id IS NULL AND '+row('o',ATTR)+' IS DISTINCT FROM '+row('p',ATTR),'Old-only place attributes')
            checks['old_only_names_changed'] = assert_zero(conn,'SELECT count(*) FROM old_names o JOIN gazetteer.names n ON n.place_id=o.place_id AND n.normalized_name=o.normalized_name LEFT JOIN source_names s ON s.place_id=o.place_id AND s.normalized_name=o.normalized_name WHERE s.place_id IS NULL AND ROW(o.name,o.priority) IS DISTINCT FROM ROW(n.name,n.priority)','Old-only name attributes')
            final_foreign_keys = conn.execute("SELECT conname,pg_get_constraintdef(oid,true),convalidated FROM pg_constraint WHERE conrelid='gazetteer.names'::regclass AND contype='f'").fetchall()
            if final_foreign_keys != foreign_keys:
                raise RuntimeError('Foreign key definition or validation changed')
            checks['foreign_key_full_validation_passed'] = True
            checks['orphans'] = 0  # Successful ADD FOREIGN KEY validated every name.
            final_counts = conn.execute('SELECT (SELECT count(*) FROM gazetteer.places),(SELECT count(*) FROM gazetteer.names)').fetchone()
            if list(final_counts) != expected:
                raise RuntimeError('Final union counts mismatch')
            if report['place_rows_written'] != report['difference']['place_additions']+p_all_changes or report['name_rows_written'] != report['difference']['name_additions']+n_changes:
                raise RuntimeError('Upsert affected-row count mismatch')
            merged_dataset = meta['dataset']+'-merged-preserve-old'
            conn.execute('''UPDATE gazetteer.snapshot SET source='GeoNames',dataset=%s,source_digest=%s,
                imported_at=clock_timestamp(),place_count=%s,name_count=%s,license='CC BY 4.0',attribution=%s WHERE singleton''',
                (merged_dataset,meta['source_digest'],*final_counts,meta['attribution']))
            report['final_snapshot'] = list(conn.execute('SELECT dataset,source_digest,place_count,name_count FROM gazetteer.snapshot WHERE singleton').fetchone())
            report['final_counts'] = list(final_counts)
            report['database_checks'] = checks
            conn.execute('COMMIT')
            report['status'] = 'database_verified_awaiting_application_checks'
            stage('database_committed',final_counts=report['final_counts'],database_checks=checks)
        except BaseException as e:
            try:
                conn.execute('ROLLBACK')
            except Exception:
                pass
            report['status'] = 'failed_backup_retained'
            report['error'] = str(e)
            save(report_path,report)
            raise

if __name__ == '__main__':
    main()
