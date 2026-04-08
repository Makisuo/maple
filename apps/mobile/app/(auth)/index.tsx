import { useSignIn, useSSO, useAuth } from "@clerk/expo";
import { Link, useRouter, type Href } from "expo-router";
import { useState } from "react";
import {
	ActivityIndicator,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";

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
	const [ssoLoading, setSsoLoading] = useState(false);

	const loading = fetchStatus === "fetching";

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
		const { error } = await signIn.password({ emailAddress, password });
		if (error) return;

		if (signIn.status === "complete") {
			await finalize();
		} else if (signIn.status === "needs_client_trust") {
			const emailCodeFactor = signIn.supportedSecondFactors?.find(
				(f) => f.strategy === "email_code",
			);
			if (emailCodeFactor) {
				await signIn.mfa.sendEmailCode();
			}
		}
	};

	const handleVerify = async () => {
		await signIn.mfa.verifyEmailCode({ code });
		if (signIn.status === "complete") {
			await finalize();
		}
	};

	const handleGoogleSignIn = async () => {
		setSsoLoading(true);
		try {
			const { createdSessionId, setActive } = await startSSOFlow({
				strategy: "oauth_google",
			});
			if (createdSessionId && setActive) {
				await setActive({ session: createdSessionId });
			}
		} catch (err) {
			console.error("Google sign-in error:", err);
		} finally {
			setSsoLoading(false);
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

						<Pressable
							className="h-12 rounded-lg bg-primary items-center justify-center"
							onPress={handleVerify}
							disabled={loading}
							style={loading ? { opacity: 0.5 } : undefined}
						>
							{loading ? (
								<ActivityIndicator size="small" color="#1a1714" />
							) : (
								<Text className="text-sm font-medium text-primary-foreground font-mono">
									Verify
								</Text>
							)}
						</Pressable>
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

				{/* Google OAuth */}
				<Pressable
					className="h-12 rounded-lg border border-border bg-transparent items-center justify-center mb-5"
					onPress={handleGoogleSignIn}
					disabled={ssoLoading}
					style={ssoLoading ? { opacity: 0.5 } : undefined}
				>
					{ssoLoading ? (
						<ActivityIndicator size="small" color="#e8e0d6" />
					) : (
						<Text className="text-sm font-medium text-foreground font-mono">
							Continue with Google
						</Text>
					)}
				</Pressable>

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

					<Pressable
						className="h-12 rounded-lg bg-primary items-center justify-center"
						onPress={handleSubmit}
						disabled={!emailAddress || !password || loading}
						style={
							!emailAddress || !password || loading
								? { opacity: 0.5 }
								: undefined
						}
					>
						{loading ? (
							<ActivityIndicator size="small" color="#1a1714" />
						) : (
							<Text className="text-sm font-medium text-primary-foreground font-mono">
								Sign in
							</Text>
						)}
					</Pressable>
				</View>

				<View className="flex-row items-center gap-1 mt-6">
					<Text className="text-sm text-muted-foreground font-mono">
						Don't have an account?
					</Text>
					<Link href="/(auth)/sign-up" hitSlop={8}>
						<Text className="text-sm text-primary font-mono">Sign up</Text>
					</Link>
				</View>
			</ScrollView>
		</KeyboardAvoidingView>
	);
}
