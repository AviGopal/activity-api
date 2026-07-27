import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

interface FailureLesson {
  id: string;
  message: string;
  timestamp: string;
}

const SUBSTRATE_GAP = 'per-gap failure lessons updated';

function updateFailureLessons(): void {
  const lessonsPath = resolve(__dirname, '../../substrate/failure-lessons.json');
  const lessons: FailureLesson[] = JSON.parse(readFileSync(lessonsPath, 'utf8'));

  const updated = lessons.map((l) =>
    l.id === SUBSTRATE_GAP ? { ...l, message: 'Resolved via substrate gap fix', timestamp: new Date().toISOString() } : l
  );

  writeFileSync(lessonsPath, JSON.stringify(updated, null, 2) + '\n');
}

updateFailureLessons();
