"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** picanteverde fork: the confirm step in front of every disruptive account action. */
export function ConfirmDialog({
	open,
	title,
	description,
	confirmLabel,
	onConfirm,
	onOpenChange,
}: {
	open: boolean;
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: () => Promise<void>;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useLanguage();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			await onConfirm();
			onOpenChange(false);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("access.actionFailed"));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!busy) { setError(null); onOpenChange(next); } }}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{error && <p role="alert" className="mb-4 text-sm text-red-600">{error}</p>}
				<div className="flex flex-wrap justify-end gap-2">
					<Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("access.cancel")}</Button>
					<Button type="button" variant="destructive" disabled={busy} onClick={() => void confirm()}>{busy ? t("common.saving") : confirmLabel}</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
