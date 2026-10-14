"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { cn } from "@/lib/utils";
import { Input } from "./input";

/**
 * picanteverde fork: a password field with a show/hide toggle (QA mobile #11). Typing a long
 * password on a phone keyboard without seeing it is error-prone.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<React.ComponentProps<"input">, "type">>(
	({ className, ...props }, ref) => {
		const { t } = useLanguage();
		const [visible, setVisible] = React.useState(false);
		return (
			<div className="relative">
				{/* Once visible it is type="text": stop mobile keyboards capitalising/autocorrecting the password. */}
				<Input ref={ref} type={visible ? "text" : "password"} autoCapitalize="none" autoCorrect="off" spellCheck={false} className={cn("pr-11", className)} {...props} />
				<button
					type="button"
					onClick={() => setVisible((value) => !value)}
					aria-label={visible ? t("auth.hidePassword") : t("auth.showPassword")}
					aria-pressed={visible}
					className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-neutral-500 hover:text-neutral-800"
				>
					{visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
				</button>
			</div>
		);
	},
);
PasswordInput.displayName = "PasswordInput";
