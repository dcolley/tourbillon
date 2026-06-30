import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, npsResponses } from '@tourbillon/db';
import { sendToSlack, buildNpsDetractorAlert } from '@/lib/slack/service';

// ============================================================================
// TOUR-61: NPS Survey API Endpoint (TOUR-97 refactored)
// 
// Accepts NPS survey responses (0–10 scale), stores them in PostgreSQL via Drizzle ORM,
// and triggers Slack alerts for detractors (score ≤ 6).
// 
// Uses the centralized @/lib/slack/service for all Slack messaging.
// ============================================================================

const npsSchema = z.object({
  userId: z.string().uuid().optional(),
  email: z.string().email('Invalid email address').optional(),
  score: z.number().int().min(0).max(10),
  comment: z.string().max(500).optional().nullable(),
});

// --- Helpers ---

function getNPSCategory(score: number): 'detractor' | 'passive' | 'promoter' {
  if (score <= 6) return 'detractor';
  if (score <= 8) return 'passive';
  return 'promoter';
}

async function notifyDetractors(score: number, email?: string, comment?: string): Promise<boolean> {
  const slackMessage = buildNpsDetractorAlert(score, comment || undefined, email);
  
  return sendToSlack({
    message: slackMessage,
    priority: 'critical',
    channel: '#customer-support',
  });
}

// --- Route Handler ---

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();
    const validation = npsSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.errors },
        { status: 400 }
      );
    }

    const data = validation.data;
    const category = getNPSCategory(data.score);

    // Store in database (PostgreSQL via Drizzle ORM)
    await db.insert(npsResponses).values({
      userId: data.userId || null,
      email: data.email || null,
      score: data.score,
      category,
      comment: data.comment || null,
    });

    // Alert on detractors (score ≤ 6) via centralized Slack service
    if (category === 'detractor') {
      await notifyDetractors(data.score, data.email, data.comment);
    }

    return NextResponse.json(
      { success: true, score: data.score, category },
      { status: 201 }
    );

  } catch (error) {
    console.error('[NPS] Error processing response:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  // Admin-only endpoint — retrieve NPS stats and recent responses
  try {
    const all = await db.select().from(npsResponses).orderBy(
      npsResponses.createdAt
    );

    const total = all.length;
    const avgScore = total > 0 ? (all.reduce((sum, r) => sum + r.score, 0) / total).toFixed(2) : 'N/A';
    const detractors = all.filter(r => r.category === 'detractor').length;

    return NextResponse.json({
      total,
      averageScore: avgScore,
      detractors,
      promoters: all.filter(r => r.category === 'promoter').length,
      responses: all.slice(-10).map(({ id, userId, email, score, category, createdAt }) => ({
        id,
        userId,
        email,
        score,
        category,
        createdAt: createdAt.toISOString(),
      })),
    });

  } catch (error) {
    console.error('[NPS] Error retrieving stats:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
