import { NextResponse } from "next/server";

/*
 * picanteverde fork: in-app restore is turned off (Phase 9, QA). On Cloudflare D1 one atomic
 * restore over a database that already holds mail exceeds the D1 CPU limit at a few thousand
 * messages (staging: 5k messages failed every time, safely, with nothing changed). A button
 * that reliably fails on any real mailbox is worse than none. Disaster recovery is D1 Time
 * Travel plus the R2 copy job: docs/picanteverde-disaster-recovery.md. The in-app backup
 * (export) stays. restoreDatabaseRecords() is kept for tests and the runbook.
 */
export async function POST() {
	return NextResponse.json(
		{ error: "In-app restore is turned off on this server. Use the disaster recovery runbook (D1 Time Travel).", code: "restore_disabled" },
		{ status: 410 },
	);
}
