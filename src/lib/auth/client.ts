"use client";

import { getUserTimeZone } from "@/lib/time/utils";
import { clearUserTimeZonePreference } from "@/lib/time/client";
import type {
	AuthFetchOptions,
	AuthSessionChangedDetail,
	AuthSessionResponse,
} from "./client-types";

const SESSION_STORAGE_KEY = "mailflare-session-token";
export const AUTH_SESSION_CHANGED_EVENT = "mailflare:auth-session-changed";
export const TOTP_ENROLLMENT_PATH = "/settings/security";

function dispatchAuthSessionChanged(authenticated: boolean): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<AuthSessionChangedDetail>(AUTH_SESSION_CHANGED_EVENT, {
			detail: { authenticated },
		}),
	);
}

export function getClientSessionToken(): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem(SESSION_STORAGE_KEY);
}

export function setClientSessionToken(token: string): void {
	const previousToken = localStorage.getItem(SESSION_STORAGE_KEY);
	localStorage.setItem(SESSION_STORAGE_KEY, token);
	if (previousToken !== token) clearUserTimeZonePreference();
	if (previousToken !== token) dispatchAuthSessionChanged(true);
}

export function clearClientSessionToken(): void {
	localStorage.removeItem(SESSION_STORAGE_KEY);
	clearUserTimeZonePreference();
	dispatchAuthSessionChanged(false);
}

export function getAuthHeaders(headers?: HeadersInit): Headers {
	const nextHeaders = new Headers(headers);
	if (typeof window !== "undefined" && !nextHeaders.has("X-Time-Zone")) {
		nextHeaders.set("X-Time-Zone", getUserTimeZone());
	}
	const token = getClientSessionToken();
	if (token && !nextHeaders.has("Authorization")) {
		nextHeaders.set("Authorization", `Bearer ${token}`);
	}
	return nextHeaders;
}

export async function authFetch(input: RequestInfo | URL, init: AuthFetchOptions = {}): Promise<Response> {
	const { redirectOnUnauthorized = true, headers, ...requestInit } = init;
	const response = await fetch(input, {
		...requestInit,
		headers: getAuthHeaders(headers),
	});

	if (response.status === 401 && redirectOnUnauthorized && typeof window !== "undefined") {
		clearClientSessionToken();
		window.location.assign("/login");
	}
	// picanteverde fork: a mailbox request that is now refused may mean a grant was revoked;
	// let the mailbox list refresh itself (the provider throttles this).
	if ((response.status === 403 || response.status === 404) && typeof window !== "undefined") {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (/mailboxId=|\/api\/mailboxes\/|\/api\/messages\//.test(url)) window.dispatchEvent(new CustomEvent("mailflare:grants-changed"));
	}
	// picanteverde fork: TOTP is mandatory. Until the account enrolls, every other API answers
	// 403 totp_enrollment_required; send the browser to the enrollment page (once).
	if (response.status === 403 && typeof window !== "undefined" && window.location.pathname !== TOTP_ENROLLMENT_PATH) {
		const body = (await response.clone().json().catch(() => null)) as { code?: string } | null;
		if (body?.code === "totp_enrollment_required") window.location.assign(TOTP_ENROLLMENT_PATH);
	}

	return response;
}

export async function persistAuthSession(response: Response): Promise<AuthSessionResponse> {
	const data = (await response.json()) as AuthSessionResponse;
	if (response.ok && data.token) setClientSessionToken(data.token);
	return data;
}
