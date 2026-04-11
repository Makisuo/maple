import { useSignUp, useSSO, useAuth } from "@clerk/expo";
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
import { SafeAreaView } from "react-native-safe-area-context";
import { GithubIcon } from "../../components/icons/github-icon";
import { GoogleIcon } from "../../components/icons/google-icon";
import {
	PrimaryButton,
	SecondaryButton,
} from "../../components/ui/button";

type SsoProvider = "google" | "github";

export default function SignUpScreen() {
	const { signUp, errors, fetchStatus } = useSignUp();
	const { startSSOFlow } = useSSO();
	const { isSignedIn } = useAuth();
	const router = useRouter();

	const [emailAddress, setEmailAddress] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [ssoLoading, setSsoLoading] = useState<SsoProvider | null>(null);

	const loading = fetchStatus === "fetching";
	const ssoBusy = ssoLoading !== null;

	const handleSubmit = async () => {
		try {
			const { error } = await signUp.password({ emailAddress, password });
			if (error) return;

			await signUp.verifications.sendEmailCode();
		} catch (err) {
			Alert.alert("Sign up failed", err instanceof Error ? err.message : "An unexpected error occurred");
		}
	};

	const handleVerify = async () => {
		await signUp.verifications.verifyEmailCode({ code });

		if (signUp.status === "complete") {
			await signUp.finalize({
				navigate: ({ session, decorateUrl }) => {
					if (session?.currentTask) return;
					const url = decorateUrl("/");
					router.push(url as Href);
				},
			});
		}
	};

	const handleSsoSignUp = async (provider: SsoProvider) => {
		setSsoLoading(provider);
		try {
			const { createdSessionId, setActive } = await startSSOFlow({
				strategy: provider === "google" ? "oauth_google" : "oauth_github",
			});
			if (createdSessionId && setActive) {
				await setActive({ session: createdSessionId });
			}
		} catch (err) {
			console.error(`${provider} sign-up error:`, err);
			Alert.alert("Sign up failed", err instanceof Error ? err.message : "An unexpected error occurred");
		} finally {
			setSsoLoading(null);
		}
	};

	if (signUp.status === "complete" || isSignedIn) return null;

	const needsVerification =
		signUp.status === "missing_requirements" &&
		signUp.unverifiedFields?.includes("email_address") &&
		signUp.missingFields?.length === 0;

	// Email verification screen
	if (needsVerification) {
		return (
			<SafeAreaView className="flex-1 bg-background">
				<KeyboardAvoidingView
					className="flex-1"
					behavior={Platform.OS === "ios" ? "padding" : "height"}
				>
					<ScrollView
						contentContainerClassName="flex-grow justify-center px-6"
						keyboardShouldPersistTaps="handled"
					>
						<Text className="mb-8 text-lg font-semibold tracking-tight text-foreground font-mono text-center">
							maple
						</Text>

						<View className="gap-1 mb-6">
							<Text className="text-xl font-semibold text-foreground font-mono">
								Verify your email
							</Text>
							<Text className="text-sm text-muted-foreground font-mono">
								Enter the code sent to {emailAddress}.
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
								onPress={() => signUp.verifications.sendEmailCode()}
								hitSlop={8}
							>
								<Text className="text-sm text-primary font-mono">Resend</Text>
							</Pressable>
						</View>
					</ScrollView>
				</KeyboardAvoidingView>
			</SafeAreaView>
		);
	}

	// Main sign-up screen
	return (
		<SafeAreaView className="flex-1 bg-background">
			<KeyboardAvoidingView
				className="flex-1"
				behavior={Platform.OS === "ios" ? "padding" : "height"}
			>
				<ScrollView
					contentContainerClassName="flex-grow justify-center px-6"
					keyboardShouldPersistTaps="handled"
				>
					<Text className="mb-8 text-lg font-semibold tracking-tight text-foreground font-mono text-center">
						maple
					</Text>

					<View className="gap-1 mb-6">
						<Text className="text-xl font-semibold text-foreground font-mono">
							Sign up
						</Text>
						<Text className="text-sm text-muted-foreground font-mono">
							Create your Maple account.
						</Text>
					</View>

					{/* SSO providers */}
					<View className="gap-3 mb-5">
						<SecondaryButton
							onPress={() => handleSsoSignUp("google")}
							loading={ssoLoading === "google"}
							disabled={ssoBusy && ssoLoading !== "google"}
							icon={<GoogleIcon />}
						>
							Continue with Google
						</SecondaryButton>
						<SecondaryButton
							onPress={() => handleSsoSignUp("github")}
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
							{errors?.fields?.emailAddress && (
								<Text className="text-sm text-destructive font-mono">
									{errors.fields.emailAddress.message}
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
								placeholder="Create a password"
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
							Sign up
						</PrimaryButton>
					</View>

					<View className="flex-row items-center gap-1 mt-6">
						<Text className="text-sm text-muted-foreground font-mono">
							Already have an account?
						</Text>
						<Link href="/(auth)/" hitSlop={8}>
							<Text className="text-sm text-primary font-mono">Sign in</Text>
						</Link>
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
