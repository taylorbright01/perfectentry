"""Upload validated M1/H1 multi-market batches. Prompts privately for the EA token.
Run only after deploying the matching collector and checking bucket lifecycle rules.
"""
import argparse, getpass, gzip, hashlib, json, pathlib, urllib.request
from import_hourly_history import send

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=pathlib.Path, required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if not args.url.startswith('https://'): parser.error('Use the HTTPS collector URL.')
    report = json.loads((args.data/'audit.json').read_text())
    for item in report['batches']:
        path = args.data/item['file']
        if path.parent != args.data or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Prepared batch file checksum failed: '+item['file'])
    if not args.dry_run:
        with urllib.request.urlopen(args.url.rstrip('/')+'/health', timeout=20) as response: health = json.load(response)
        if health.get('historyVersion', 0) < 3 or health.get('retentionBars') != 100000:
            raise ValueError('Deploy the new collector first; M1 and 100,000-bar retention are not enabled.')
        token = getpass.getpass('Existing EA collector token (hidden): ')
        if len(token) < 32: raise ValueError('Collector token must have at least 32 characters.')
    checkpoint = args.data/'import-progress.json'
    progress = json.loads(checkpoint.read_text()) if checkpoint.exists() and not args.dry_run else {}
    for item in report['batches']:
        done = progress.get(item['sha256'], 0)
        with gzip.open(args.data/item['file'], 'rt', encoding='utf-8') as f:
            count = 0
            for index, line in enumerate(f):
                batch = json.loads(line); count += 1
                if index < done: continue
                if batch['base_timeframe'] not in (60, 3600) or sum(len(s['candles']) for s in batch['streams']) > 3000:
                    raise ValueError('Invalid prepared batch.')
                if not args.dry_run:
                    send(args.url.rstrip('/'), token, batch)
                    progress[item['sha256']] = index+1
                    temp = checkpoint.with_suffix('.tmp'); temp.write_text(json.dumps(progress)); temp.replace(checkpoint)
                if (index+1) % 25 == 0: print(item['file'], index+1, '/', item['batches'], 'batches', flush=True)
            if count != item['batches']: raise ValueError('Prepared batch count mismatch.')
    print('Validated successfully.' if args.dry_run else 'Import complete. History is retained independently for M1 and H1. Reload Perfect View.')

if __name__ == '__main__':
    main()
