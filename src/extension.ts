/**
 * CodePause Extension Entry Point
 * Orchestrates all components and manages extension lifecycle
 */

import * as vscode from "vscode";
import { DatabaseManager } from "./storage/DatabaseManager";
import { DataRetentionManager } from "./storage/DataRetentionManager";
import { MetricsRepository } from "./storage/MetricsRepository";
import { ConfigRepository } from "./storage/ConfigRepository";
import { ConfigManager } from "./config/ConfigManager";
import { MetricsCollector } from "./core/MetricsCollector";
import { ThresholdManager } from "./core/ThresholdManager";
import { applyStoredCustomThresholds } from "./utils/applyCustomThresholds";
import { StatusBarManager } from "./ui/StatusBarManager";
import { NotificationService } from "./ui/NotificationService";
import { DashboardProvider } from "./ui/DashboardProvider";
import { OnboardingManager } from "./onboarding/OnboardingManager";
import { ErrorReporter } from "./errors/ErrorReporter";
import { ProgressTracker } from "./gamification/ProgressTracker";
import { AchievementSystem } from "./gamification/AchievementSystem";
import { SnoozeManager } from "./customization/SnoozeManager";
import { DataExporter } from "./customization/DataExporter";
import { SettingsProvider } from "./ui/SettingsProvider";
import { AlertEngine } from "./alerts/AlertEngine";
import { BlindApprovalDetector } from "./core/BlindApprovalDetector";
import { AssignmentManager } from "./assignments/AssignmentManager";
import { PolicyEngine } from "./assignments/PolicyEngine";
import { AssignmentReportGenerator } from "./assignments/AssignmentReportGenerator";
import { writeAssignmentReport } from "./assignments/AssignmentReportFile";
import { UpdateService } from "./updates/UpdateService";
import { IntegrityService } from "./integrity/IntegrityService";
import { execSync } from "child_process";
import { EventType, DeveloperLevel } from "./types";
import { isGitRepository } from "./utils/SecurityUtils";
import { getToday } from "./utils/DateUtils";
import {
  registerCommandSafe,
  resetCommandRegistration,
} from "./utils/CommandRegistration";

// Extension state
let databaseManager: DatabaseManager | null = null;
let dataRetentionManager: DataRetentionManager | null = null;
let metricsRepository: MetricsRepository | null = null;
let configRepository: ConfigRepository | null = null;
let configManager: ConfigManager | null = null;
let metricsCollector: MetricsCollector | null = null;
let assignmentManager: AssignmentManager | null = null;
let policyEngine: PolicyEngine | null = null;
let thresholdManager: ThresholdManager | null = null;
let statusBarManager: StatusBarManager | null = null;
let notificationService: NotificationService | null = null;
let dashboardProvider: DashboardProvider | null = null;
let onboardingManager: OnboardingManager | null = null;
let progressTracker: ProgressTracker | null = null;
let achievementSystem: AchievementSystem | null = null;
let snoozeManager: SnoozeManager | null = null;
let errorReporter: ErrorReporter | null = null;
let dataExporter: DataExporter | null = null;
let settingsProvider: SettingsProvider | null = null;
let alertEngine: AlertEngine | null = null;
let blindApprovalDetector: BlindApprovalDetector | null = null;
let updateService: UpdateService | null = null;
let integrityService: IntegrityService | null = null;

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
  try {
    // Initialize error reporting (local only - output channel + user prompt)
    errorReporter = new ErrorReporter(context);

    // Initialize storage
    await initializeStorage(context);

    // Check if workspace is a git repository
    await checkGitRepository(context);

    // Register commands
    await registerCommands(context);

    // Initialize metrics collector and trackers (Phase 2)
    await initializeTrackers(context);

    // Initialize UI components (Phase 4)
    await initializeUI(context);

    // Initialize alert system (Phase 5)
    await initializeAlerts(context);

    // Initialize gamification (Phase 6)
    await initializeGamification(context);

    // Initialize customization (Phase 7)
    await initializeCustomization(context);

    // Initialize onboarding manager
    onboardingManager = new OnboardingManager(context, configManager!);

    // Check if user needs onboarding (delay by 2 seconds to let VS Code fully load)
    if (await onboardingManager.needsOnboarding()) {
      setTimeout(async () => {
        if (onboardingManager) {
          await onboardingManager.start();
        }
      }, 2000);
    } else {
      // Show activation message via notification service
      notificationService?.showProgressNotification(
        "CodeVibe is now tracking your AI usage",
      );
    }

    const automaticUpdates = vscode.workspace
      .getConfiguration("codePause")
      .get<boolean>("autoUpdateChecks", true);
    if (automaticUpdates) {
      setTimeout(() => {
        void checkForUpdates(false);
      }, 5000);
    }

    // Integrity self-check (opt-in, default on). Runs after activation so it
    // never blocks startup. Warns + offers reinstall if the extension was
    // tampered with.
    const integrityEnabled = vscode.workspace
      .getConfiguration("codePause")
      .get<boolean>("integrityCheck", true);
    if (integrityEnabled && integrityService) {
      setTimeout(() => {
        void integrityService!.checkAndRepair();
      }, 8000);
    }
  } catch (error) {
    console.error("Failed to activate CodeVibe:", error);

    // Report activation error
    if (errorReporter && error instanceof Error) {
      errorReporter.reportError(error, "activation");
    }

    vscode.window.showErrorMessage(
      `CodeVibe failed to activate: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Get the current workspace path
 * Handles single workspace, multi-root, and no workspace scenarios
 */
function getWorkspacePath(): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length === 0) {
    // No workspace - single file mode
    return undefined;
  }

  if (workspaceFolders.length === 1) {
    // Single workspace (most common)
    return workspaceFolders[0].uri.fsPath;
  }

  // Multi-root workspace: use the first folder as primary
  // In the future, we could let users select which workspace to track
  return workspaceFolders[0].uri.fsPath;
}

/**
 * Extension deactivation
 */
export async function deactivate() {
  // Drop our command registrations so a re-activation in the same process
  // starts clean instead of colliding with itself (issue #4).
  resetCommandRegistration();

  // Dispose error reporting
  if (errorReporter) {
    errorReporter.dispose();
    errorReporter = null;
  }

  // Dispose customization
  if (snoozeManager) {
    snoozeManager.dispose();
    snoozeManager = null;
  }

  dataExporter = null;
  settingsProvider = null;

  // Dispose gamification
  if (achievementSystem) {
    achievementSystem.dispose();
    achievementSystem = null;
  }

  if (progressTracker) {
    progressTracker.dispose();
    progressTracker = null;
  }

  // Dispose UI components
  if (statusBarManager) {
    statusBarManager.dispose();
    statusBarManager = null;
  }

  if (notificationService) {
    notificationService.clearAll();
    notificationService = null;
  }

  // Dispose metrics collector
  if (metricsCollector) {
    await metricsCollector.dispose();
    metricsCollector = null;
  }

  assignmentManager = null;
  policyEngine = null;

  // Stop data retention cleanup scheduler
  if (dataRetentionManager) {
    dataRetentionManager.stopCleanupScheduler();
    dataRetentionManager = null;
  }

  // Clean up database connection
  if (databaseManager) {
    // Ensure all data is synced before closing
    databaseManager.sync();
    databaseManager.close();
    databaseManager = null;
  }

  // Clean up other resources
  metricsRepository = null;
  configRepository = null;
  configManager = null;
  thresholdManager = null;
  dashboardProvider = null;
  updateService = null;
  integrityService = null;
}

async function checkForUpdates(manual: boolean): Promise<void> {
  if (!updateService) {
    if (manual) {
      vscode.window.showErrorMessage("CodeVibe updater is not initialized");
    }
    return;
  }

  try {
    const release = await updateService.checkForUpdate(manual);
    if (!release) {
      if (manual) {
        vscode.window.showInformationMessage("CodeVibe is up to date");
      }
      return;
    }

    const notes = release.body.trim().slice(0, 3500) || "No release notes provided.";
    const action = await vscode.window.showInformationMessage(
      `CodeVibe ${release.version} is available.\n\n${notes}`,
      "Update now",
      "Later",
    );
    if (action === "Later") {
      updateService.dismiss(release.version);
      return;
    }
    if (action !== "Update now") {
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Updating CodeVibe" },
      async (progress) => {
        progress.report({ message: `Downloading ${release.version}...` });
        await updateService!.install(release);
      },
    );

    const reload = await vscode.window.showInformationMessage(
      `CodeVibe ${release.version} installed. Reload VS Code to finish the update.`,
      "Reload Window",
    );
    if (reload === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch (error) {
    console.error("CodeVibe update check failed:", error);
    if (manual) {
      vscode.window.showErrorMessage(
        `CodeVibe update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Initialize storage layer
 * Now creates workspace-specific databases for project isolation
 */
async function initializeStorage(
  _context: vscode.ExtensionContext,
): Promise<void> {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const storagePath = path.join(os.homedir(), ".codepause");

  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  // Get current workspace path for project-specific database
  const workspacePath = getWorkspacePath();

  // Create DatabaseManager with workspace-specific path
  databaseManager = new DatabaseManager(storagePath, workspacePath);
  await databaseManager.initialize();

  // Issues #6/#7: a corrupt database now recovers instead of blocking
  // activation, but that means the numbers on screen start from empty. Say so
  // plainly - silently presenting a zeroed history on an integrity tool would
  // be worse than the crash.
  if (databaseManager.recoveredFromCorruption) {
    const where = databaseManager.quarantinedDbPath
      ? ` The unreadable file was kept at ${databaseManager.quarantinedDbPath}.`
      : "";
    console.warn(
      `[CodeVibe] Database recovery: history before today is unavailable.${where}`,
    );
    void vscode.window.showWarningMessage(
      `CodeVibe found an unreadable database and started a fresh one, so history from before today is missing.${where}`,
    );
  }

  // Initialize data retention manager (30-day rolling window for free tier)
  dataRetentionManager = new DataRetentionManager(_context, databaseManager);
  dataRetentionManager.startCleanupScheduler();

  metricsRepository = new MetricsRepository(databaseManager);
  // Pass globalState to ConfigRepository for user-level onboarding persistence
  configRepository = new ConfigRepository(
    databaseManager,
    _context.globalState,
  );

  configManager = new ConfigManager(configRepository);
  await configManager.initialize();

  // Apply the anonymizePaths preference to the storage layer, then migrate
  // any pre-existing absolute paths so old data stops leaking usernames too.
  const userConfig = await configRepository.getUserConfig();
  databaseManager.setAnonymizePaths(userConfig.anonymizePaths !== false);
  databaseManager.migrateAnonymizeExistingPaths();

  // Keep storage in sync if the user toggles the setting at runtime.
  configManager.setOnConfigApplied((applied) => {
    databaseManager?.setAnonymizePaths(applied.anonymizePaths !== false);
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
/**
 * Check if workspace is a git repository and show warning if not
 */
async function checkGitRepository(
  _context: vscode.ExtensionContext,
): Promise<void> {
  const workspacePath = getWorkspacePath();

  if (!workspacePath) {
    return; // No workspace open, skip check
  }

  const isGitRepo = isGitRepository(workspacePath);

  if (!isGitRepo) {
    // Show warning that git repository is recommended
    const action = await vscode.window.showWarningMessage(
      "CodeVibe works best with git repositories. AI detection accuracy may be reduced without git.",
      "Initialize Git",
      "Learn More",
      "Dismiss",
    );

    if (action === "Initialize Git") {
      // Open terminal and suggest git init command
      const terminal = vscode.window.createTerminal("CodeVibe Git Setup");
      terminal.show();
      terminal.sendText("# Initialize git repository for better AI tracking");
      terminal.sendText("git init");
      terminal.sendText("git add -A");
      terminal.sendText('git commit -m "Initial commit"');
    } else if (action === "Learn More") {
      vscode.env.openExternal(
        vscode.Uri.parse(
          "https://github.com/codepause/codepause-extension#git-repository-requirement",
        ),
      );
    }
  }
}

async function initializeTrackers(
  _context: vscode.ExtensionContext,
): Promise<void> {
  if (!metricsRepository || !configManager) {
    throw new Error("Storage must be initialized before trackers");
  }

  // Initialize assignment management before metrics collector so active assignment is loaded
  assignmentManager = new AssignmentManager(metricsRepository);
  policyEngine = new PolicyEngine();

  // Initialize metrics collector with assignment management
  metricsCollector = new MetricsCollector(
    metricsRepository,
    configManager,
    assignmentManager,
    policyEngine,
  );
  await metricsCollector.initialize();
}

async function initializeUI(context: vscode.ExtensionContext): Promise<void> {
  if (!metricsRepository || !configRepository || !configManager) {
    throw new Error("Storage must be initialized before UI");
  }

  // Initialize threshold manager with user's experience level AND custom thresholds.
  // Without this, custom thresholds (e.g. max AI percentage, min review time) set in
  // settings are silently ignored and ThresholdManager falls back to level defaults.
  const userConfig = await configRepository.getUserConfig();
  thresholdManager = new ThresholdManager(userConfig.experienceLevel);
  applyStoredCustomThresholds(thresholdManager, configManager);

  // Initialize notification service
  notificationService = new NotificationService(configRepository);

  // Initialize status bar manager
  statusBarManager = new StatusBarManager(
    metricsRepository,
    configRepository,
    thresholdManager,
  );
  await statusBarManager.initialize();

  // Initialize dashboard provider
  dashboardProvider = new DashboardProvider(
    context.extensionUri,
    metricsRepository,
    configRepository,
    thresholdManager,
    metricsCollector ?? undefined, // Pass metrics collector to access FileReviewSessionTracker
  );

  // Register dashboard view
  try {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        DashboardProvider.viewType,
        dashboardProvider,
      ),
    );
  } catch (error) {
    console.warn(
      "[CodeVibe] Dashboard view provider already registered, skipping:",
      error instanceof Error ? error.message : error,
    );
  }

  // Wire integrity service to the dashboard so a tampered build locks the UI.
  if (integrityService && dashboardProvider) {
    integrityService.setDashboardCallbacks({
      lock: (msg) => dashboardProvider!.lockDashboard(msg),
      unlock: () => dashboardProvider!.unlockDashboard(),
    });
  }
}

/**
 * Initialize alert system
 */
async function initializeAlerts(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (
    !metricsRepository ||
    !configRepository ||
    !thresholdManager ||
    !notificationService
  ) {
    throw new Error("Required components must be initialized before alerts");
  }

  // Initialize blind approval detector
  const thresholds = thresholdManager.getConfig();
  blindApprovalDetector = new BlindApprovalDetector(thresholds);

  // Initialize alert engine
  alertEngine = new AlertEngine(configRepository);

  // Connect real-time alert system to MetricsCollector
  // This will be called immediately when events are tracked
  if (metricsCollector) {
    metricsCollector.onEvent(async (event) => {
      // Only process suggestion accepted events
      if (
        event.eventType !== EventType.SuggestionAccepted ||
        !event.acceptanceTimeDelta
      ) {
        return;
      }

      // Skip alerts for scanner/historical events (files detected after creation)
      // These aren't real-time acceptances, so don't trigger blind approval alerts
      const metadata = event.metadata as any;
      if (
        metadata?.scanner ||
        metadata?.closedFileModification ||
        metadata?.fileCreation
      ) {
        // These are historical events from the scanner, not real-time user actions
        return;
      }

      try {
        // Real-time blind approval detection
        const detection = blindApprovalDetector!.detect(event);

        if (detection.isBlindApproval) {
          const shouldShow =
            await alertEngine!.shouldShowBlindApprovalAlert(detection);

          if (shouldShow) {
            const alert = alertEngine!.createBlindApprovalAlert(detection);
            await notificationService!.showAlert(alert);
            await alertEngine!.recordAlertShown(alert);
          }
        }
      } catch (error) {
        console.error("[AlertSystem] Error in real-time alert check:", error);
      }
    });

    // Show XP gains for events (with smart filtering)
    metricsCollector.onEvent(async (event) => {
      // Don't show XP for scanner/historical events
      const metadata = event.metadata as any;
      if (metadata?.scanner || metadata?.closedFileModification) {
        return;
      }

      try {
        // Map event types to XP gain descriptions
        let action = "";
        let shouldShow = false;

        switch (event.eventType) {
          case EventType.SuggestionAccepted:
            action = "Reviewed AI suggestion";
            shouldShow = false; // Don't show for every acceptance (too frequent)
            break;
          case EventType.SuggestionRejected:
            action = "Rejected AI suggestion";
            shouldShow = false;
            break;
          case EventType.CodeGenerated:
            action = "Generated code with AI";
            shouldShow = false;
            break;
          case EventType.SessionStart:
            action = "Started coding session";
            shouldShow = true; // Show for sessions
            break;
          default:
            return;
        }

        if (action && notificationService) {
          await notificationService.showXPGain(1, action, shouldShow);
        }
      } catch (error) {
        console.error("[XPSystem] Error showing XP gain:", error);
      }
    });

    // AUTO-REFRESH FIX: Automatically refresh dashboard when events are processed
    metricsCollector.onEvent(async () => {
      // Refresh dashboard for all event types to keep UI in sync
      if (dashboardProvider) {
        await dashboardProvider.refresh();
      }
    });
  }

  // Function to check thresholds (can be called manually or periodically)
  const checkThresholds = async (force: boolean = false): Promise<void> => {
    if (!alertEngine || !metricsRepository || !thresholdManager) {
      return;
    }

    try {
      const now = Date.now();
      const timeSinceLastCheck = now - lastThresholdCheckTime;

      if (!force && timeSinceLastCheck < 10 * 60 * 1000) {
        return;
      }

      const today = getToday();
      const metrics = await metricsRepository.getDailyMetrics(today);

      if (!metrics || metrics.totalEvents <= 10) {
        return;
      }

      const currentThresholds = thresholdManager.getConfig();

      // Check AI percentage threshold
      if (metrics.aiPercentage > currentThresholds.maxAIPercentage) {
        const shouldShow = await alertEngine.shouldShowThresholdAlert(
          metrics,
          "aiPercentage",
        );
        const isSnoozed = configRepository
          ? await configRepository.isSnoozed()
          : false;

        if (shouldShow && !isSnoozed) {
          const alert = alertEngine.createThresholdAlert(
            metrics,
            "aiPercentage",
            currentThresholds.maxAIPercentage,
          );

          if (alert) {
            await notificationService!.showAlert(alert);
            await alertEngine.recordAlertShown(alert);
            lastThresholdCheckTime = now;
          }
        }
      }

      // Check for review reminders - unreviewed AI-generated files
      const unreviewedFiles = await metricsRepository.getUnreviewedFiles(today);
      if (unreviewedFiles && unreviewedFiles.length > 0) {
        const totalLines = unreviewedFiles.reduce(
          (sum, f) => sum + (f.linesGenerated || 0),
          0,
        );
        const avgScore =
          unreviewedFiles.reduce((sum, f) => sum + (f.reviewScore || 0), 0) /
          unreviewedFiles.length;

        const shouldShowReminder = await alertEngine.shouldShowReviewReminder(
          unreviewedFiles.length,
          totalLines,
          avgScore,
        );

        if (shouldShowReminder) {
          const alert = alertEngine.createReviewReminderAlert(
            unreviewedFiles.length,
            totalLines,
            unreviewedFiles.map((f) => f.filePath),
          );

          if (alert) {
            await notificationService!.showAlert(alert);
            await alertEngine.recordAlertShown(alert);
          }
        }
      }
    } catch (error) {
      console.error("CodeVibe: Error in threshold check:", error);
    }
  };

  // Periodic threshold check (once every 10 minutes for AI percentage warnings)
  let lastThresholdCheckTime = 0;
  const thresholdCheckInterval = setInterval(
    () => {
      checkThresholds(false);
    },
    5 * 60 * 1000,
  ); // Check every 5 minutes, but only alert every 10 min

  context.subscriptions.push({
    dispose: () => clearInterval(thresholdCheckInterval),
  });

  // Manual threshold check command (for testing/debugging)
  const checkThresholdsNow = await registerCommandSafe(
    "codePause.checkThresholds",
    async () => {
      await checkThresholds(true);
      vscode.window.showInformationMessage(
        "Threshold check completed. Check console for details.",
      );
    },
  );
  context.subscriptions.push(checkThresholdsNow);

  // Test notification command (for verifying notification visibility)
  const testNotification = await registerCommandSafe(
    "codePause.testNotification",
    async () => {
      // Test 1: Modal notification
      await vscode.window.showInformationMessage(
        "TEST NOTIFICATION (Modal)",
        { modal: true },
        "I see this!",
        "Not visible",
      );

      // Test 2: Non-modal notification
      await vscode.window.showInformationMessage(
        "TEST NOTIFICATION (Non-Modal) - This should appear in top-right corner or notification center",
        { modal: false },
        "I see this!",
        "Not visible",
      );

      // Test 3: Warning message
      await vscode.window.showWarningMessage(
        "TEST WARNING - Check if you can see this warning notification",
        { modal: false },
        "Visible",
        "Not visible",
      );

      vscode.window.showInformationMessage("Test complete!");
    },
  );
  context.subscriptions.push(testNotification);
}

/**
 * Initialize gamification components
 */
async function initializeGamification(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!metricsRepository || !configRepository) {
    throw new Error("Storage must be initialized before gamification");
  }

  // Check if gamification is enabled
  const config = await configRepository.getUserConfig();
  if (!config.enableGamification) {
    return;
  }

  // Initialize progress tracker
  progressTracker = new ProgressTracker(metricsRepository, configRepository);
  await progressTracker.initialize();

  // Initialize achievement system
  achievementSystem = new AchievementSystem(
    metricsRepository,
    configRepository,
    progressTracker,
  );
  await achievementSystem.initialize();

  // Connect event handlers
  if (notificationService && achievementSystem && progressTracker) {
    // Handle achievement unlocks and progress milestones
    achievementSystem.onAchievementUnlocked(async (achievement) => {
      // Check if this is a progress notification vs actual unlock
      const metadata = (achievement as any).metadata;
      if (metadata?.isProgressNotification) {
        // Show progress notification
        await notificationService!.showAchievementProgress(
          achievement.title,
          achievement.progress || 0,
          achievement.icon,
        );
      } else {
        // Show unlock notification
        await notificationService!.showAchievementUnlocked(
          achievement.title,
          achievement.description,
        );
      }

      // Refresh dashboard and status bar
      if (dashboardProvider) {
        await dashboardProvider.refresh();
      }
      if (statusBarManager) {
        await statusBarManager.refresh();
      }
    });

    // Handle level ups
    progressTracker.onLevelUp(async (level) => {
      const title = progressTracker!.getLevelTitle(level);
      const icon = progressTracker!.getLevelIcon(level);

      await notificationService!.showLevelUp(level, title, icon);

      // Show special message in status bar
      if (statusBarManager) {
        statusBarManager.showTemporaryMessage(`🎉 Level ${level}!`, 5000);
      }
    });
  }

  // Connect gamification with metrics collection
  // Set up periodic checks for achievements based on metrics
  const gamificationCheckInterval = setInterval(
    async () => {
      if (achievementSystem && progressTracker) {
        // Update progression (adds XP from events)
        await progressTracker.updateProgression();

        // Check relevant achievements periodically
        await achievementSystem.checkRelevantAchievements("daily");
      }
    },
    5 * 60 * 1000,
  ); // Check every 5 minutes

  context.subscriptions.push({
    dispose: () => clearInterval(gamificationCheckInterval),
  });
}

/**
 * Initialize customization components
 */
async function initializeCustomization(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!metricsRepository || !configRepository || !thresholdManager) {
    throw new Error(
      "Required components must be initialized before customization",
    );
  }

  // Initialize snooze manager
  snoozeManager = new SnoozeManager(configRepository);
  await snoozeManager.initialize();

  // Initialize data exporter
  dataExporter = new DataExporter(metricsRepository, configRepository);

  // Initialize settings provider
  settingsProvider = new SettingsProvider(
    context.extensionUri,
    configRepository,
    thresholdManager,
  );

  // Connect snooze manager to status bar
  if (statusBarManager && snoozeManager) {
    snoozeManager.onSnoozeChanged(async () => {
      await statusBarManager!.refresh();
    });
  }
}

/**
 * Register VSCode commands
 */
async function registerCommands(
  context: vscode.ExtensionContext,
): Promise<void> {
  updateService = new UpdateService({
    currentVersion: context.extension.packageJSON.version,
    repository:
      vscode.workspace.getConfiguration("codePause").get("updateRepository") ||
      "waka-man/codevibe",
  });

  integrityService = new IntegrityService(updateService);

  const checkForUpdatesCommand = await registerCommandSafe(
    "codePause.checkForUpdates",
    async () => checkForUpdates(true),
  );

  // Open Dashboard command
  const openDashboard = await registerCommandSafe(
    "codePause.openDashboard",
    async () => {
      if (dashboardProvider) {
        // Reveal the view in the sidebar (this will open the sidebar if closed)
        // Using 'workbench.view.extension.codePause' to reveal the entire view container
        await vscode.commands.executeCommand(
          "workbench.view.extension.codePause",
        );

        // Then focus the dashboard view specifically
        await vscode.commands.executeCommand("codePause.dashboardView.focus");

        // Refresh the dashboard content
        await dashboardProvider.refresh();
      } else {
        vscode.window.showErrorMessage("Dashboard not available");
      }
    },
  );

  // Start Onboarding command
  const startOnboarding = await registerCommandSafe(
    "codePause.startOnboarding",
    async () => {
      if (onboardingManager) {
        await onboardingManager.start();
      } else {
        vscode.window.showErrorMessage("Onboarding not available");
      }
    },
  );

  // Reset Onboarding command (for testing)
  const resetOnboarding = await registerCommandSafe(
    "codePause.resetOnboarding",
    async () => {
      if (onboardingManager) {
        await onboardingManager.reset();
        vscode.window
          .showInformationMessage(
            "Onboarding reset successfully. Reload VS Code to restart onboarding.",
            "Reload Now",
          )
          .then((action) => {
            if (action === "Reload Now") {
              vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          });
      } else {
        vscode.window.showErrorMessage("Onboarding not available");
      }
    },
  );

  // Open Settings command
  const openSettings = await registerCommandSafe(
    "codePause.openSettings",
    async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "codePause",
      );
    },
  );

  // Snooze command (updated to use SnoozeManager)
  const snooze = await registerCommandSafe(
    "codePause.snooze",
    async () => {
      if (!snoozeManager) {
        vscode.window.showErrorMessage("CodeVibe is not initialized");
        return;
      }

      await snoozeManager.showSnoozeDialog();
    },
  );

  // Show stats command (for testing)
  const showDatabaseInfo = await registerCommandSafe(
    "codePause.showDatabaseInfo",
    async () => {
      if (!databaseManager) {
        vscode.window.showInformationMessage("Database not initialized");
        return;
      }

      // Get database stats to verify it's working
      let statsInfo = "";
      try {
        const stats = await databaseManager.getStats();
        statsInfo =
          `\n\nDatabase Stats:\n` +
          `• Total Events: ${stats.totalEvents}\n` +
          `• Total Sessions: ${stats.totalSessions}\n` +
          `• Database Size: ${(stats.databaseSize / 1024).toFixed(2)} KB\n` +
          `✅ Database is working correctly!`;
      } catch (error) {
        statsInfo = `\n\n⚠️ Could not read database stats: ${error}`;
      }

      const message =
        `Database Backend: node-sqlite3-wasm\n\n` +
        `Status: ✅ Active\n\n` +
        `✅ Using node-sqlite3-wasm (WebAssembly SQLite)\n` +
        `• Cross-platform compatibility: Works on all Node.js versions (20+)\n` +
        `• No native compilation required\n` +
        `• Works across all VS Code and Electron versions\n` +
        `• Full SQLite 3.51.1 implementation\n` +
        `• Persistent file system storage\n` +
        `• Zero configuration needed\n\n` +
        `Performance: Excellent for extension use cases\n` +
        `Reliability: 100% - no NODE_MODULE_VERSION issues ever!` +
        statsInfo;

      vscode.window.showInformationMessage(message, { modal: true });
    },
  );

  // Manual data cleanup command (for testing 30-day retention)
  const cleanupOldData = await registerCommandSafe(
    "codePause.cleanupOldData",
    async () => {
      if (!dataRetentionManager) {
        vscode.window.showErrorMessage(
          "Data retention manager not initialized",
        );
        return;
      }

      await dataRetentionManager.triggerManualCleanup();
    },
  );

  // Purge historical false positives from generated/dependency paths
  // (node_modules, venv, build outputs recorded before the ignore list).
  const purgeExcludedData = await registerCommandSafe(
    "codePause.purgeExcludedData",
    async () => {
      if (!metricsRepository) {
        vscode.window.showErrorMessage("CodeVibe is not initialized");
        return;
      }

      try {
        const result = await metricsRepository.purgeExcludedEvents();

        if (dashboardProvider) {
          await dashboardProvider.refresh(true);
        }
        if (statusBarManager) {
          await statusBarManager.refresh();
        }

        vscode.window.showInformationMessage(
          `Excluded-path purge complete: removed ${result.eventsDeleted} event(s) and ${result.fileReviewsDeleted} file review(s) across ${result.datesRecalculated.length} day(s).`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Purge failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
  );

  const showStats = await registerCommandSafe(
    "codePause.showStats",
    async () => {
      if (!metricsRepository) {
        vscode.window.showErrorMessage("CodeVibe is not initialized");
        return;
      }

      const stats = await metricsRepository.getStatsSummary();

      vscode.window.showInformationMessage(
        `CodeVibe Stats:\n` +
          `Total Events: ${stats.totalEvents}\n` +
          `Total Sessions: ${stats.totalSessions}\n` +
          `Database Size: ${(stats.databaseSize / 1024).toFixed(2)} KB`,
      );
    },
  );

  // Diagnostic command to check alert system status
  const diagnoseAlerts = await registerCommandSafe(
    "codePause.diagnoseAlerts",
    async () => {
      if (
        !alertEngine ||
        !configRepository ||
        !snoozeManager ||
        !blindApprovalDetector
      ) {
        vscode.window.showErrorMessage("Alert system not initialized");
        return;
      }

      try {
        // Check snooze status
        const snoozeState = await configRepository.getSnoozeState();
        const isSnoozed = await configRepository.isSnoozed();

        // Check rate limits for each alert type
        const alertTypes = [
          { type: "GentleNudge", limit: 5 * 60 * 1000 },
          { type: "EducationalMoment", limit: 30 * 60 * 1000 },
          { type: "StreakWarning", limit: 10 * 60 * 1000 },
        ];

        const rateLimitStatus = await Promise.all(
          alertTypes.map(async ({ type, limit }) => {
            const history = await configRepository!.getAlertHistory(
              type as any,
            );
            if (!history) {
              return `${type}: ✅ Can show (never shown)`;
            }
            const timeSince = Date.now() - history.lastShown;
            const canShow = timeSince >= limit;
            const minutesAgo = Math.floor(timeSince / 60000);
            return `${type}: ${canShow ? "✅" : "⏸️"} ${canShow ? "Can show" : `Rate limited (${minutesAgo}m ago, need ${Math.floor(limit / 60000)}m)`}`;
          }),
        );

        // Get blind approval detector stats
        const detectorStats = blindApprovalDetector.getStats();

        // Get today's metrics
        const today = getToday();
        const metrics = metricsRepository
          ? await metricsRepository.getDailyMetrics(today)
          : null;

        const message =
          `🔍 Alert System Diagnostics\n\n` +
          `📊 Snooze Status:\n` +
          `   ${isSnoozed ? "⏸️ SNOOZED" : "✅ Active"}\n` +
          (isSnoozed && snoozeState.snoozeUntil
            ? `   Until: ${new Date(snoozeState.snoozeUntil).toLocaleString()}\n`
            : "") +
          `\n⏱️ Rate Limits:\n` +
          rateLimitStatus.map((s) => `   ${s}`).join("\n") +
          `\n\n🎯 Blind Approval Detection:\n` +
          `   Recent Acceptances: ${detectorStats.recentCount}\n` +
          `   Rapid Acceptances: ${detectorStats.recentRapidCount}\n` +
          `   Avg Review Time: ${detectorStats.averageReviewTime.toFixed(0)}ms\n` +
          `\n📈 Today's Metrics:\n` +
          (metrics
            ? `   AI Percentage: ${metrics.aiPercentage.toFixed(1)}%\n` +
              `   Avg Review Time: ${metrics.averageReviewTime.toFixed(0)}ms\n` +
              `   Total Events: ${metrics.totalEvents}\n` +
              `   Manual Lines: ${metrics.totalManualLines}`
            : "   No metrics yet") +
          `\n\n💡 Issues Found:\n` +
          (isSnoozed ? "   ⚠️ Alerts are snoozed - no alerts will show\n" : "") +
          (metrics && metrics.aiPercentage > 60
            ? "   ⚠️ AI usage exceeds 60% threshold\n"
            : "") +
          (detectorStats.recentRapidCount >= 3
            ? "   ⚠️ Pattern detected (3+ rapid accepts)\n"
            : "");

        vscode.window.showInformationMessage(message, { modal: true });
      } catch (error) {
        vscode.window.showErrorMessage(`Diagnostic error: ${error}`);
      }
    },
  );

  // Refresh dashboard command
  const refreshDashboard = await registerCommandSafe(
    "codePause.refreshDashboard",
    async () => {
      // Force immediate metrics aggregation
      if (metricsCollector) {
        await metricsCollector.triggerAggregation();
      }

      if (dashboardProvider) {
        await dashboardProvider.refresh(true); // Force HTML update to pick up code changes
      }
      if (statusBarManager) {
        await statusBarManager.refresh();
      }
      if (progressTracker) {
        await progressTracker.updateProgression();
      }
      if (achievementSystem) {
        await achievementSystem.triggerCheck();
      }

      vscode.window.showInformationMessage(
        "Dashboard refreshed (HTML regenerated)",
      );
    },
  );

  // Show progression command
  const showProgression = await registerCommandSafe(
    "codePause.showProgression",
    async () => {
      if (!progressTracker) {
        vscode.window.showErrorMessage("Gamification is not enabled");
        return;
      }

      const summary = await progressTracker.getProgressionSummary();
      const quote = await progressTracker.getMotivationalQuote();

      vscode.window.showInformationMessage(`${summary}\n\n💭 "${quote}"`);
    },
  );

  // Assignment commands
  const createAssignment = await registerCommandSafe(
    "codePause.createAssignment",
    async () => {
      if (!assignmentManager || !metricsCollector) {
        vscode.window.showErrorMessage("Assignment manager not initialized");
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: "Assignment name",
        placeHolder: "e.g. Homework 3 - Binary Search Trees",
      });

      if (!name) {
        return;
      }

      const startDate = await vscode.window.showInputBox({
        prompt: "Start date (YYYY-MM-DD)",
        value: getToday(),
      });

      if (!startDate) {
        return;
      }

      const endDate = await vscode.window.showInputBox({
        prompt: "End date (YYYY-MM-DD)",
        value: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0],
      });

      if (!endDate) {
        return;
      }

      const repoUrl = await vscode.window.showInputBox({
        prompt: "Student git repository URL (optional)",
        placeHolder: "https://github.com/student/repo",
      });

      const maxAuthorship = await vscode.window.showInputBox({
        prompt: "Maximum allowed AI authorship %",
        value: "30",
      });

      const minOwnership = await vscode.window.showInputBox({
        prompt: "Minimum ownership/review score (0-100)",
        value: "40",
      });

      try {
        const assignment = await assignmentManager.createAssignment({
          name,
          startDate,
          endDate,
          repoUrl: repoUrl || undefined,
          policy: {
            maxAuthorshipPercentage: parseInt(maxAuthorship || "30", 10),
            minOwnershipScore: parseInt(minOwnership || "40", 10),
          },
        });

        await assignmentManager.activateAssignment(assignment.id);
        await metricsCollector.refreshActiveAssignment();

        vscode.window
          .showInformationMessage(
            `Assignment "${assignment.name}" created and activated.`,
            "Open Dashboard",
          )
          .then((action) => {
            if (action === "Open Dashboard") {
              vscode.commands.executeCommand("codePause.openDashboard");
            }
          });
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to create assignment: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      }
    },
  );

  const activateAssignment = await registerCommandSafe(
    "codePause.activateAssignment",
    async () => {
      if (!assignmentManager || !metricsCollector) {
        vscode.window.showErrorMessage("Assignment manager not initialized");
        return;
      }

      const assignments = await assignmentManager.listAssignments();
      if (assignments.length === 0) {
        vscode.window.showInformationMessage(
          "No assignments found. Create one first.",
        );
        return;
      }

      const selected = await vscode.window.showQuickPick(
        assignments.map((a) => ({
          label: a.name,
          description: `${a.startDate} → ${a.endDate}`,
          value: a.id,
        })),
        { placeHolder: "Select assignment to activate" },
      );

      if (selected) {
        await assignmentManager.activateAssignment(selected.value);
        await metricsCollector.refreshActiveAssignment();
        vscode.window.showInformationMessage(
          `Activated assignment: ${selected.label}`,
        );
      }
    },
  );

  const deactivateAssignment = await registerCommandSafe(
    "codePause.deactivateAssignment",
    async () => {
      if (!assignmentManager || !metricsCollector) {
        vscode.window.showErrorMessage("Assignment manager not initialized");
        return;
      }

      await assignmentManager.deactivateAssignment();
      await metricsCollector.refreshActiveAssignment();
      vscode.window.showInformationMessage("Assignment tracking deactivated");
    },
  );

  const showAssignmentStatus = await registerCommandSafe(
    "codePause.showAssignmentStatus",
    async () => {
      if (!assignmentManager || !metricsCollector || !metricsRepository) {
        vscode.window.showErrorMessage("Assignment manager not initialized");
        return;
      }

      const active = await assignmentManager.getActiveAssignment();
      if (!active) {
        vscode.window.showInformationMessage(
          "No active assignment. Create or activate one first.",
        );
        return;
      }

      const events = await metricsRepository.getEventsForAssignment(active);
      const fileReviews = await metricsRepository.getFileReviewsForDateRange(
        active.startDate,
        active.endDate,
      );
      const metrics = policyEngine!.computeMetrics(active, events, fileReviews);

      const violationSummary =
        metrics.violations.length === 0
          ? "No policy violations detected ✅"
          : metrics.violations
              .map((v) => `• ${v.message} (${v.severity})`)
              .join("\n");

      const message =
        `📚 Assignment: ${active.name}\n\n` +
        `Authorship: ${metrics.authorship.authorshipPercentage.toFixed(1)}% AI ` +
        `(limit: ${active.policy.maxAuthorshipPercentage}%)\n` +
        `Ownership: ${metrics.ownership.score.toFixed(1)}/100 ` +
        `(minimum: ${active.policy.minOwnershipScore})\n` +
        `Files needing review: ${metrics.ownership.filesUnreviewed}\n\n` +
        `Violations:\n${violationSummary}`;

      vscode.window.showInformationMessage(message, { modal: true });
    },
  );

  const exportAssignmentReport = await registerCommandSafe(
    "codePause.exportAssignmentReport",
    async () => {
      try {
        if (
          !assignmentManager ||
          !metricsCollector ||
          !metricsRepository ||
          !policyEngine
        ) {
          vscode.window.showErrorMessage("Assignment manager not initialized");
          return;
        }

        // Prefer the active assignment; otherwise let the student pick one.
        let assignment = await assignmentManager.getActiveAssignment();
        if (!assignment) {
          const all = await assignmentManager.listAssignments();
          if (all.length === 0) {
            vscode.window.showInformationMessage(
              "No assignments found. Create one first.",
            );
            return;
          }
          const selected = await vscode.window.showQuickPick(
            all.map((a) => ({
              label: a.name,
              description: `${a.startDate} → ${a.endDate}`,
              value: a.id,
            })),
            { placeHolder: "Select assignment to export" },
          );
          if (!selected) {
            return;
          }
          assignment = all.find((a) => a.id === selected.value) ?? null;
          if (!assignment) {
            return;
          }
        }

        const studentIdentifier = await vscode.window.showInputBox({
          prompt: "Your student identifier (optional) - embedded in the report",
          placeHolder: "e.g. student ID or email",
        });
        if (studentIdentifier === undefined) {
          return;
        } // cancelled

      // Best effort: record the current git HEAD of the workspace
      let repoHeadCommit: string | undefined;
      try {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (folder) {
          repoHeadCommit = execSync("git rev-parse HEAD", {
            cwd: folder,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        }
      } catch {
        // Not a git repository or git unavailable - report is still valid
      }

      const events = await metricsRepository.getEventsForAssignment(assignment);
      const fileReviews = await metricsRepository.getFileReviewsForDateRange(
        assignment.startDate,
        assignment.endDate,
      );
      const metrics = policyEngine.computeMetrics(
        assignment,
        events,
        fileReviews,
      );

      // Tamper-evidence: embed exclusion-list changes inside the window.
      // Custom globs are ignored while the assignment is active (lockdown),
      // so these entries document attempts, sealed by the integrity hash.
      let exclusionAudit: Array<{
        timestamp: number;
        globs: string[];
        source: string;
      }> = [];
      try {
        const windowStart = new Date(assignment.startDate).getTime();
        const windowEnd =
          new Date(assignment.endDate).getTime() + 86400000 - 1;
        exclusionAudit = await metricsRepository.getExclusionAudit(
          windowStart,
          windowEnd,
        );
      } catch {
        // Audit is best-effort; the report is still valid without it
      }

      const report = new AssignmentReportGenerator().generate(
        assignment,
        metrics,
        {
          studentIdentifier: studentIdentifier.trim() || undefined,
          repoUrl: assignment.repoUrl,
          repoHeadCommit,
          exclusionAudit,
        },
      );

      const safeName =
        assignment.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "assignment";
      const defaultUri = vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders[0].uri,
            `${safeName}.report.json`,
          )
        : undefined;

      const target = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { JSON: ["json"] },
        saveLabel: "Export Report",
      });
      if (!target) {
        return;
      }

        await writeAssignmentReport(
          (uri, content) => vscode.workspace.fs.writeFile(uri, content),
          target,
          report,
        );

      const shortHash = report.integrity.hash.slice(0, 12);
        vscode.window
          .showInformationMessage(
            `Assignment report exported (integrity: ${shortHash}…). Submit this file with your assignment.`,
            "Show File",
          )
          .then((action) => {
            if (action === "Show File") {
              void vscode.commands
                .executeCommand("revealFileInOS", target)
                .then(undefined, (error) => {
                  console.error("Failed to reveal assignment report:", error);
                });
            }
          });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error("Failed to export assignment report:", error);
        vscode.window.showErrorMessage(
          `Failed to export assignment report: ${detail}`,
        );
      }
    },
  );

  // Show achievements command
  const showAchievements = await registerCommandSafe(
    "codePause.showAchievements",
    async () => {
      if (!achievementSystem) {
        vscode.window.showErrorMessage("Gamification is not enabled");
        return;
      }

      const summary = await achievementSystem.getAchievementsSummary();

      vscode.window.showInformationMessage(summary);
    },
  );

  // Show advanced settings command
  const showAdvancedSettings = await registerCommandSafe(
    "codePause.showAdvancedSettings",
    async () => {
      if (!settingsProvider) {
        vscode.window.showErrorMessage("Settings not available");
        return;
      }

      await settingsProvider.show();
    },
  );

  // Export data command
  const exportData = await registerCommandSafe(
    "codePause.exportData",
    async () => {
      if (!dataExporter) {
        vscode.window.showErrorMessage("Data exporter not available");
        return;
      }

      await dataExporter.showExportDialog();
    },
  );

  // Import data command
  const importData = await registerCommandSafe(
    "codePause.importData",
    async () => {
      if (!dataExporter) {
        vscode.window.showErrorMessage("Data importer not available");
        return;
      }

      await dataExporter.importData();
    },
  );

  // Show snooze status command
  const showSnoozeStatus = await registerCommandSafe(
    "codePause.showSnoozeStatus",
    async () => {
      if (!snoozeManager) {
        vscode.window.showErrorMessage("Snooze manager not available");
        return;
      }

      const status = await snoozeManager.getSnoozeStatus();
      vscode.window.showInformationMessage(status);
    },
  );

  // Change experience level command
  const changeExperienceLevel = await registerCommandSafe(
    "codePause.changeExperienceLevel",
    async () => {
      if (!configRepository) {
        vscode.window.showErrorMessage("CodeVibe is not initialized");
        return;
      }

      const currentConfig = await configRepository.getUserConfig();
      const options = [
        {
          label: "Junior Developer",
          description: "AI usage limit: 40% (build fundamentals first)",
          value: DeveloperLevel.Junior,
        },
        {
          label: "Mid-Level Developer",
          description: "AI usage limit: 60% (have fundamentals, leverage AI)",
          value: DeveloperLevel.Mid,
        },
        {
          label: "Senior Developer",
          description: "AI usage limit: 70% (productivity-focused)",
          value: DeveloperLevel.Senior,
        },
      ];

      const selected = await vscode.window.showQuickPick(options, {
        placeHolder: `Current level: ${currentConfig.experienceLevel}`,
        title: "Select Your Experience Level",
      });

      if (selected) {
        await configRepository.setExperienceLevel(selected.value);

        // Update threshold manager
        if (thresholdManager && configManager) {
          thresholdManager.setLevel(selected.value);
          // Re-apply stored custom thresholds (setLevel resets to level defaults)
          applyStoredCustomThresholds(thresholdManager, configManager);
        }

        // Refresh UI
        if (dashboardProvider) {
          await dashboardProvider.refresh();
        }
        if (statusBarManager) {
          await statusBarManager.refresh();
        }

        vscode.window.showInformationMessage(
          `Experience level changed to: ${selected.label}`,
        );
      }
    },
  );

  // Force full scan command (for debugging/recovery)
  const forceFullScan = await registerCommandSafe(
    "codePause.forceFullScan",
    async () => {
      if (!metricsCollector) {
        vscode.window.showErrorMessage("CodeVibe is not initialized");
        return;
      }

      vscode.window.showInformationMessage(
        "Scanning workspace for AI-generated files...",
      );

      // Trigger scan on Cursor tracker
      const trackers = (metricsCollector as any).trackers;
      const cursorTracker = trackers?.get("cursor");

      if (cursorTracker && typeof cursorTracker.forceFullScan === "function") {
        await cursorTracker.forceFullScan();

        // Wait a moment for events to be processed
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Trigger aggregation
        await metricsCollector.triggerAggregation();

        // Refresh UI
        if (dashboardProvider) {
          await dashboardProvider.refresh();
        }
        if (statusBarManager) {
          await statusBarManager.refresh();
        }

        vscode.window.showInformationMessage(
          "Scan complete! Dashboard updated.",
        );
      } else {
        vscode.window.showWarningMessage("Cursor tracker not available");
      }
    },
  );

  const resetAchievements = await registerCommandSafe(
    "codePause.resetAchievements",
    async () => {
      const result = await vscode.window.showWarningMessage(
        "This will reset all achievements and progress. Are you sure?",
        { modal: true },
        "Yes, Reset",
      );

      if (result === "Yes, Reset" && achievementSystem && configRepository) {
        const achievements = await configRepository.getAllAchievements();
        for (const achievement of achievements) {
          await configRepository.updateAchievementProgress(
            achievement.id,
            0,
            false,
          );
        }

        if (dashboardProvider) {
          await dashboardProvider.refresh();
        }

        vscode.window.showInformationMessage(
          "All achievements have been reset",
        );
      }
    },
  );

  const clearAllData = await registerCommandSafe(
    "codePause.clearAllData",
    async () => {
      const result = await vscode.window.showWarningMessage(
        "This will delete ALL tracked data, including events, metrics, and achievements. This cannot be undone. Are you sure?",
        { modal: true },
        "Yes, Clear Everything",
      );

      if (result === "Yes, Clear Everything" && databaseManager) {
        const fs = require("fs");
        const path = require("path");
        const os = require("os");

        // Get the actual database path from the database manager
        const dbPath = (databaseManager as any).dbPath;

        // Close the database connection
        databaseManager.close();

        // Delete the workspace-specific database if it exists
        if (dbPath && fs.existsSync(dbPath)) {
          fs.unlinkSync(dbPath);
        }

        // Also clean up old database location if it exists
        const oldDbPath = path.join(os.homedir(), ".codepause", "codepause.db");
        if (fs.existsSync(oldDbPath)) {
          fs.unlinkSync(oldDbPath);
        }

        // Clean up global.db if it exists
        const globalDbPath = path.join(os.homedir(), ".codepause", "global.db");
        if (fs.existsSync(globalDbPath)) {
          fs.unlinkSync(globalDbPath);
        }

        // CORRECT FIX: Clear baseline file when clearing all data
        // This ensures stale baselines from previous tests don't interfere
        // On reload, baselines will be reestablished from:
        //   1. Open files → current line count
        //   2. Git projects → git HEAD
        //   3. Closed files (no git) → treated as new file (correct behavior)
        const workspaceFolder =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceFolder) {
          const baselinesPath = path.join(
            workspaceFolder,
            ".vscode",
            "codepause-baselines.json",
          );
          if (fs.existsSync(baselinesPath)) {
            fs.unlinkSync(baselinesPath);
          }
        }

        vscode.window
          .showInformationMessage(
            "All data cleared. Please reload the window to reinitialize.",
            "Reload Window",
          )
          .then((selection) => {
            if (selection === "Reload Window") {
              vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          });
      }
    },
  );

  // Register all commands
  context.subscriptions.push(
    openDashboard,
    startOnboarding,
    resetOnboarding,
    openSettings,
    snooze,
    showStats,
    showDatabaseInfo,
    cleanupOldData,
    purgeExcludedData,
    refreshDashboard,
    diagnoseAlerts,
    showProgression,
    showAchievements,
    showAdvancedSettings,
    exportData,
    importData,
    showSnoozeStatus,
    changeExperienceLevel,
    forceFullScan,
    resetAchievements,
    clearAllData,
    createAssignment,
    activateAssignment,
    deactivateAssignment,
    showAssignmentStatus,
    exportAssignmentReport,
    checkForUpdatesCommand,
  );
}

// Export for testing
export function getDatabaseManager(): DatabaseManager | null {
  return databaseManager;
}

export function getMetricsRepository(): MetricsRepository | null {
  return metricsRepository;
}

export function getAssignmentManager(): AssignmentManager | null {
  return assignmentManager;
}

export function getPolicyEngine(): PolicyEngine | null {
  return policyEngine;
}
