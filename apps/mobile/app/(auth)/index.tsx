import { useSignIn, useSSO, useAuth } from "@clerk/expo";
import { Link, useRouter, type Href } from "expo-router";
import { useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import { GithubIcon } from "../../components/icons/github-icon";
import { GoogleIcon } from "../../components/icons/google-icon";
import {
	PrimaryButton,
	SecondaryButton,
} from "../../components/ui/button";
import { hapticError, hapticSuccess } from "../../lib/haptics";

type SsoProvider = "google" | "github";

export default function SignInScreen() {
	const { isSignedIn } = useAuth();

	if (isSignedIn) return null;

	return (
		<View className="flex-1 bg-background justify-center px-6">
			<Text className="mb-8 text-lg font-semibold tracking-tight text-foreground font-mono text-center">
				maple
			</Text>
			<SignInForm />
		</View>
	);
}

function SignInForm() {
	const { signIn, errors, fetchStatus } = useSignIn();
	const { startSSOFlow } = useSSO();
	const router = useRouter();

	const [emailAddress, setEmailAddress] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [ssoLoading, setSsoLoading] = useState<SsoProvider | null>(null);

	const loading = fetchStatus === "fetching";
	const ssoBusy = ssoLoading !== null;

	const finalize = async () => {
		await signIn.finalize({
			navigate: ({ session, decorateUrl }) => {
				if (session?.currentTask) return;
				const url = decorateUrl("/");
				router.push(url as Href);
			},
		});
	};

	const handleSubmit = async () => {
		try {
			const { error } = await signIn.password({ emailAddress, password });
			if (error) return;

			if (signIn.status === "complete") {
				hapticSuccess();
				await finalize();
			} else if (signIn.status === "needs_client_trust") {
				const emailCodeFactor = signIn.supportedSecondFactors?.find(
					(f) => f.strategy === "email_code",
				);
				if (emailCodeFactor) {
					await signIn.mfa.sendEmailCode();
				}
			}
		} catch (err) {
			hapticError();
			Alert.alert("Sign in failed", err instanceof Error ? err.message : "An unexpected error occurred");
		}
	};

	const handleVerify = async () => {
		await signIn.mfa.verifyEmailCode({ code });
		if (signIn.status === "complete") {
			hapticSuccess();
			await finalize();
		}
	};

	const handleSsoSignIn = async (provider: SsoProvider) => {
		setSsoLoading(provider);
		try {
			const { createdSessionId, setActive } = await startSSOFlow({
				strategy: provider === "google" ? "oauth_google" : "oauth_github",
			});
			if (createdSessionId && setActive) {
				hapticSuccess();
				await setActive({ session: createdSessionId });
			}
		} catch (err) {
			hapticError();
			console.error(`${provider} sign-in error:`, err);
			Alert.alert("Sign in failed", err instanceof Error ? err.message : "An unexpected error occurred");
		} finally {
			setSsoLoading(null);
		}
	};

	// Verification code screen
	if (signIn.status === "needs_client_trust") {
		return (
			<KeyboardAvoidingView
				className="flex-1"
				behavior={Platform.OS === "ios" ? "padding" : "height"}
			>
				<ScrollView
					contentContainerClassName="flex-grow justify-center"
					keyboardShouldPersistTaps="handled"
				>
					<View className="gap-1 mb-6">
						<Text className="text-xl font-semibold text-foreground font-mono">
							Verify your account
						</Text>
						<Text className="text-sm text-muted-foreground font-mono">
							Enter the code sent to your email.
						</Text>
					</View>

					<View className="gap-4">
						<TextInput
							className="h-12 rounded-lg border border-input bg-transparent px-3 text-sm text-foreground font-mono"
							value={code}
							placeholder="Verification code"
							placeholderTextColor="#8a7f72"
							onChangeText={setCode}
							keyboardType="numeric"
							autoFocus
						/>
						{errors?.fields?.code && (
							<Text className="text-sm text-destructive font-mono">
								{errors.fields.code.message}
							</Text>
						)}

						<PrimaryButton onPress={handleVerify} loading={loading}>
							Verify
						</PrimaryButton>
					</View>

					<View className="flex-row items-center gap-1 mt-6">
						<Text className="text-sm text-muted-foreground font-mono">
							Didn't receive a code?
						</Text>
						<Pressable
							onPress={() => signIn.mfa.sendEmailCode()}
							hitSlop={8}
						>
							<Text className="text-sm text-primary font-mono">Resend</Text>
						</Pressable>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		);
	}

	// Main sign-in screen
	return (
		<KeyboardAvoidingView
			className="flex-1"
			behavior={Platform.OS === "ios" ? "padding" : "height"}
		>
			<ScrollView
				contentContainerClassName="flex-grow justify-center"
				keyboardShouldPersistTaps="handled"
			>
				<View className="gap-1 mb-6">
					<Text className="text-xl font-semibold text-foreground font-mono">
						Sign in
					</Text>
					<Text className="text-sm text-muted-foreground font-mono">
						Sign in to your Maple account.
					</Text>
				</View>

				{/* SSO providers */}
				<View className="gap-3 mb-5">
					<SecondaryButton
						onPress={() => handleSsoSignIn("google")}
						loading={ssoLoading === "google"}
						disabled={ssoBusy && ssoLoading !== "google"}
						icon={<GoogleIcon />}
					>
						Continue with Google
					</SecondaryButton>
					<SecondaryButton
						onPress={() => handleSsoSignIn("github")}
						loading={ssoLoading === "github"}
						disabled={ssoBusy && ssoLoading !== "github"}
						icon={<GithubIcon />}
					>
						Continue with GitHub
					</SecondaryButton>
				</View>

				{/* Divider */}
				<View className="flex-row items-center gap-4 mb-5">
					<View className="flex-1 h-px bg-border" />
					<Text className="text-xs text-muted-foreground font-mono">or</Text>
					<View className="flex-1 h-px bg-border" />
				</View>

				{/* Email/Password form */}
				<View className="gap-4">
					<View className="gap-2">
						<Text className="text-sm font-medium text-foreground font-mono">
							Email address
						</Text>
						<TextInput
							className="h-12 rounded-lg border border-input bg-transparent px-3 text-sm text-foreground font-mono"
							autoCapitalize="none"
							value={emailAddress}
							placeholder="Enter email"
							placeholderTextColor="#8a7f72"
							onChangeText={setEmailAddress}
							keyboardType="email-address"
							autoCorrect={false}
						/>
						{errors?.fields?.identifier && (
							<Text className="text-sm text-destructive font-mono">
								{errors.fields.identifier.message}
							</Text>
						)}
					</View>

					<View className="gap-2">
						<Text className="text-sm font-medium text-foreground font-mono">
							Password
						</Text>
						<TextInput
							className="h-12 rounded-lg border border-input bg-transparent px-3 text-sm text-foreground font-mono"
							value={password}
							placeholder="Enter password"
							placeholderTextColor="#8a7f72"
							secureTextEntry
							onChangeText={setPassword}
						/>
						{errors?.fields?.password && (
							<Text className="text-sm text-destructive font-mono">
								{errors.fields.password.message}
							</Text>
						)}
					</View>

					<PrimaryButton
						onPress={handleSubmit}
						loading={loading}
						disabled={!emailAddress || !password || ssoBusy}
					>
						Sign in
					</PrimaryButton>
				</View>

				<View className="flex-row items-center gap-1 mt-6">
					<Text className="text-sm text-muted-foreground font-mono">
						Don't have an account?
					</Text>
					<Link href="/(auth)/sign-up" asChild>
						<Pressable hitSlop={8}>
							<Text className="text-sm text-primary font-mono">Sign up</Text>
						</Pressable>
					</Link>
				</View>
			</ScrollView>
		</KeyboardAvoidingView>
	);
}
