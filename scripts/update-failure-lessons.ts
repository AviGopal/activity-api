import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

interface FailureLesson {
  gapId: string;
  lesson: string;
  timestamp: string;
}

interface GapDetectorResult {
  gaps: Array<{
    id: string;
    failureLessons?: FailureLesson[];
  }>;
}

const FAILURE_LESSONS_FILE = join(import.meta.dir, '..', 'data', 'failure-lessons.json');

async function loadFailureLessons(): Promise<Record<string, FailureLesson[]>> {
  try {
    const content = await readFile(FAILURE_LESSONS_FILE, 'utf8');
    return JSON.parse(content) as Record<string, FailureLesson[]>;
  } catch {
    return {};
  }
}

async function saveFailureLessons(lessons: Record<string, FailureLesson[]>): Promise<void> {
  await writeFile(FAILURE_LESSONS_FILE, JSON.stringify(lessons, null, 2) + '\n');
}

async function updateGapFailureLessons(result: GapDetectorResult): Promise<void> {
  const lessons = await loadFailureLessons();

  for (const gap of result.gaps) {
    if (!gap.failureLessons) continue;

    const existing = lessons[gap.id] ?? [];
    const updated = [...existing, ...gap.failureLessons].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    lessons[gap.id] = updated;
  }

  await saveFailureLessons(lessons);
}

export async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: bun run update-failure-lessons <gap-detector-result.json>');
    process.exit(1);
  }

  const result: GapDetectorResult = JSON.parse(await readFile(input, 'utf8'));
  await updateGapFailureLessons(result);
  console.log('Updated failure lessons for gaps:', result.gaps.map(g => g.id).join(', '));
}

if (import.meta.main) {
  await main();
}
