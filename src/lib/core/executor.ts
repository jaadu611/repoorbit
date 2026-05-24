import * as vscode from 'vscode';

export class RepoOrbitExecutor {
    /**
     * Programmatically bypasses confirmation dialogs and agent step prompts
     * by focusing the agent panel and calling VS Code acceptance commands.
     */
    public static async bypassConfirmation(): Promise<void> {
        console.log(`[RepoOrbitExecutor] Triggering auto-approval bypass sequence...`);

        // We delay the first bypass sequence to allow the IDE's custom 
        // validation modal or chat step card to render. We then execute the programmatic
        // acceptance commands to bypass the chat-based confirmation prompt.
        const totalBypasses = 5;
        const delayBetweenBypasses = 500;

        const sendBypassSequence = async (index: number) => {
            if (index >= totalBypasses) {
                return;
            }

            console.log(`[RepoOrbitExecutor] Programmatically accepting agent step: Sequence ${index + 1}/${totalBypasses}`);
            
            try {
                // Focus the agent side panel (non-toggling) to make sure active context is correct
                await vscode.commands.executeCommand('antigravity.agentSidePanel.focus');
            } catch (focusErr) {
                // Ignore focus errors
            }

            try {
                // Accept the active agent step card in the chat pane
                await vscode.commands.executeCommand('antigravity.acceptAgentStep');
                console.log(`[RepoOrbitExecutor] Direct agent step accept executed.`);
            } catch (err: any) {
                console.warn('[RepoOrbitExecutor] Failed to execute antigravity.acceptAgentStep:', err.message);
            }

            try {
                // Accept any file edits or other pending changes
                await vscode.commands.executeCommand('chatEditing.acceptAllFiles');
            } catch (err) {
                // Ignore
            }

            try {
                await vscode.commands.executeCommand('chatEditor.action.acceptAllEdits');
            } catch (err) {
                // Ignore
            }

            try {
                await vscode.commands.executeCommand('chatEditing.multidiff.acceptAllFiles');
            } catch (err) {
                // Ignore
            }

            try {
                await vscode.commands.executeCommand('workbench.action.chat.acceptTool');
            } catch (err) {
                // Ignore
            }

            try {
                await vscode.commands.executeCommand('workbench.action.chat.acceptElicitation');
            } catch (err) {
                // Ignore
            }

            try {
                await vscode.commands.executeCommand('inlineChat2.keep');
            } catch (err) {
                // Ignore
            }

            try {
                await vscode.commands.executeCommand('notification.acceptPrimaryAction');
            } catch (err) {
                // Ignore
            }

            try {
                await vscode.commands.executeCommand('inlineChat.acceptChanges');
            } catch (err) {
                // Ignore
            }

            try {
                await vscode.commands.executeCommand('antigravity.prioritized.agentAcceptAllInFile');
            } catch (err) {
                // Ignore
            }

            try {
                await vscode.commands.executeCommand('notebook.inlineChat.acceptChangesAndRun');
            } catch (err) {
                // Ignore
            }

            // Schedule the next bypass sequence in the series
            setTimeout(() => {
                sendBypassSequence(index + 1);
            }, delayBetweenBypasses);
        };

        setTimeout(() => {
            sendBypassSequence(0);
        }, 250);
    }
}
