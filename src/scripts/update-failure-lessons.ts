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

const FAILURE_LESSONS_FILE = join(import.meta.dirname, '..', '..', 'data', 'failure-lessons.json');

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

export async function updateFailureLessons(result: GapDetectorResult): Promise<void> {
  const lessonsMap: Record<string, FailureLesson[]> = await loadFailureLessons();

  for (const [gapId, existingLessons] of Object.entries(lessonsMap)) {
    if (existingLessons && existingLessons.length > 0) {
      const updated = [...existingLessons].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      lessonsMap[gapId] = updated;
    }
  }

  for (const gap of result.gaps) {
    if (!gap.failureLessons) {
      throw new Error(`No failure lessons found for gap ID: ${gap.id}`);
    }

    const existing = lessonsMap[gap.id] ?? [];
    const updated = [...existing, ...gap.failureLessons].filter((lesson, index, self) => 
      index === self.findIndex(l => l.timestamp === lesson.timestamp && l.lesson === lesson.lesson)
    ).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    lessonsMap[gap.id] = updated;
  }

  await saveFailureLessons(lessonsMap);
}
