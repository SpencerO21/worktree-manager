import * as vscode from 'vscode';
import {
  GitDiagnosticEvent,
  setGitDiagnosticListener,
} from './git';

export interface DiagnosticsReport {
  extensionVersion: string;
  gitVersion: string;
  scope: string;
  workspaceFolders: string[];
  searchPaths: string[];
  repositories: string[];
  configSources: string[];
  configErrors: string[];
}

/** Git timings plus an on-demand, secret-free discovery report. */
export class WorktreeDiagnostics implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('TreeHugger');

  constructor() {
    setGitDiagnosticListener((event) => this.recordGit(event));
  }

  show(report: DiagnosticsReport): void {
    this.output.appendLine('');
    this.output.appendLine(`TreeHugger diagnostics — ${new Date().toISOString()}`);
    this.output.appendLine(`Extension: ${report.extensionVersion}`);
    this.output.appendLine(`Git: ${report.gitVersion}`);
    this.output.appendLine(`Scope: ${report.scope}`);
    appendList(this.output, 'Workspace folders', report.workspaceFolders);
    appendList(this.output, 'Configured search paths', report.searchPaths);
    appendList(this.output, 'Discovered repositories', report.repositories);
    appendList(this.output, 'Lifecycle configuration sources', report.configSources);
    appendList(this.output, 'Lifecycle configuration errors', report.configErrors);
    this.output.show(true);
  }

  dispose(): void {
    setGitDiagnosticListener(undefined);
    this.output.dispose();
  }

  private recordGit(event: GitDiagnosticEvent): void {
    const status = event.error ? 'FAIL' : 'OK';
    const command = ['git', ...event.args].map(redactGitArgument).map(shellDisplay).join(' ');
    const cwd = event.cwd ? ` cwd=${shellDisplay(event.cwd)}` : '';
    this.output.appendLine(
      `[${new Date().toISOString()}] ${status} ${command} (${event.durationMs}ms)${cwd}`,
    );
    if (event.error) {
      this.output.appendLine(`  ${redactGitArgument(event.error)}`);
    }
  }
}

function appendList(output: vscode.OutputChannel, label: string, values: string[]): void {
  output.appendLine(`${label}:`);
  if (values.length === 0) {
    output.appendLine('  (none)');
    return;
  }
  for (const value of values) {
    output.appendLine(`  ${value}`);
  }
}

/** Remove credentials and sensitive config values before a command reaches the log. */
export function redactGitArgument(value: string): string {
  const withoutUrlCredentials = value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi,
    '$1[redacted]@',
  );
  if (/^(?:http\..*extraheader|credential\..*|.*(?:token|password|authorization).*)=/i.test(
    withoutUrlCredentials,
  )) {
    return `${withoutUrlCredentials.slice(0, withoutUrlCredentials.indexOf('=') + 1)}[redacted]`;
  }
  return withoutUrlCredentials.replace(
    /\b(authorization|token|password)(\s*[:=]\s*)\S+/gi,
    '$1$2[redacted]',
  );
}

function shellDisplay(value: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}
