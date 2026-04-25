import SwiftUI
import Translation

struct ContentView: View {
    enum Screen: Hashable {
        case hebrew
        case english
    }

    @EnvironmentObject private var sessionStore: SessionStore
    @State private var selectedScreen: Screen = .hebrew
    @State private var isShowingSetup = false

    var body: some View {
        NavigationStack {
            TabView(selection: $selectedScreen) {
                LiveHebrewView()
                    .tabItem {
                        Label("Hebrew", systemImage: "globe")
                    }
                    .tag(Screen.hebrew)

                EnglishTranscriptView()
                    .tabItem {
                        Label("English", systemImage: "textformat.abc")
                    }
                    .tag(Screen.english)
            }
            .navigationTitle(selectedScreen == .hebrew ? "Live Hebrew" : "English Panel")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Setup") {
                        isShowingSetup = true
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button(sessionStore.isListening ? "Stop" : "Start") {
                        Task {
                            await sessionStore.toggleListening()
                        }
                    }
                    .fontWeight(.semibold)
                }
            }
        }
        .sheet(isPresented: $isShowingSetup) {
            SetupView()
                .environmentObject(sessionStore)
        }
        .task {
            await sessionStore.refreshCapabilities()
        }
        .translationTask(sessionStore.translationConfiguration) { session in
            await sessionStore.processPendingTranslation(using: session)
        }
    }
}

private struct LiveHebrewView: View {
    @EnvironmentObject private var sessionStore: SessionStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                StatusCard(
                    title: "Session Status",
                    message: sessionStore.listeningStatus.message
                )

                LiveTextCard(
                    title: "Current Hebrew",
                    text: sessionStore.currentHebrewText,
                    placeholder: "Start listening to see the live Hebrew translation."
                )

                SegmentListCard(
                    title: "Recent Hebrew Lines",
                    items: sessionStore.recentSegments.map(\.hebrewText)
                )
            }
            .padding(20)
        }
        .background(Color(.systemGroupedBackground))
    }
}

private struct EnglishTranscriptView: View {
    @EnvironmentObject private var sessionStore: SessionStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                StatusCard(
                    title: "Recognizer Status",
                    message: sessionStore.listeningStatus.message
                )

                LiveTextCard(
                    title: "Current English",
                    text: sessionStore.currentEnglishText,
                    placeholder: "The live English transcription appears here."
                )

                SegmentListCard(
                    title: "Recent English Lines",
                    items: sessionStore.recentSegments.map(\.englishText)
                )
            }
            .padding(20)
        }
        .background(Color(.systemGroupedBackground))
    }
}

private struct SetupView: View {
    @EnvironmentObject private var sessionStore: SessionStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("What To Prepare") {
                    Text("1. Grant microphone permission.")
                    Text("2. Grant speech-recognition permission.")
                    Text("3. Download English and Hebrew translation assets if iOS prompts you.")
                    Text("4. Place the iPhone where it can hear the JBL speaker clearly.")
                }

                Section("Current State") {
                    Text("Input mode: \(sessionStore.appMode.displayName)")
                    Text(sessionStore.listeningStatus.message)

                    if let lastError = sessionStore.translationCoordinator.lastErrorMessage {
                        Text(lastError)
                            .foregroundStyle(.red)
                    }
                }

                Section("Actions") {
                    Button("Request Permissions") {
                        Task {
                            _ = await sessionStore.requestPermissionsIfNeeded()
                        }
                    }

                    Button("Prepare Translation") {
                        sessionStore.translationCoordinator.ensureConfiguration()
                    }

                    Button("Clear History", role: .destructive) {
                        sessionStore.clearHistory()
                    }
                }
            }
            .navigationTitle("Setup")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}

private struct StatusCard: View {
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.background, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

private struct LiveTextCard: View {
    let title: String
    let text: String
    let placeholder: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.headline)

            Text(text.isEmpty ? placeholder : text)
                .font(.system(size: 30, weight: .semibold, design: .rounded))
                .frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(text.isEmpty ? .secondary : .primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.background, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

private struct SegmentListCard: View {
    let title: String
    let items: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.headline)

            if items.isEmpty {
                Text("No finalized lines yet.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Text(item)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 8)
                        .overlay(alignment: .bottom) {
                            Divider()
                        }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.background, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
