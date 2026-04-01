function toolNode(id, toolName, options) {
  return {
    kind: 'tool',
    id,
    toolName,
    input: options?.input,
    retry: options?.retry,
    timeoutMs: options?.timeoutMs,
  };
}
function sequenceNode(id, steps) {
  return { kind: 'sequence', id, steps };
}
function parallelNode(id, steps, maxConcurrency, failFast) {
  return { kind: 'parallel', id, steps, maxConcurrency, failFast };
}

const workflowId = 'workflow.electron-bridge-mapper.v1';

const electronBridgeMapperWorkflow = {
  kind: 'workflow-contract',
  version: 1,
  id: workflowId,
  displayName: 'Electron Bridge Mapper',
  description:
    'Maps Electron/NW.js application internals: inspects app structure, checks Electron fuses, sniffs IPC channels, scans preload scripts for bridge APIs, extracts ASAR contents, and identifies exposed Node.js APIs — producing a bridge surface map for exploit analysis.',
  tags: ['reverse', 'electron', 'bridge', 'ipc', 'preload', 'asar', 'nwjs', 'mission'],
  timeoutMs: 10 * 60_000,
  defaultMaxConcurrency: 3,

  build(ctx) {
    const prefix = 'workflows.electronBridgeMapper';
    const targetPath = String(ctx.getConfig(`${prefix}.targetPath`, ''));
    const maxConcurrency = Number(ctx.getConfig(`${prefix}.parallel.maxConcurrency`, 3));
    const sniffDuration = Number(ctx.getConfig(`${prefix}.sniffDurationMs`, 5000));
    const extractAsar = Boolean(ctx.getConfig(`${prefix}.extractAsar`, true));

    const steps = [
      // Phase 1: Electron App Inspection
      toolNode('inspect-app', 'electron_inspect_app', { input: {} }),
      toolNode('check-fuses', 'electron_check_fuses', { input: {} }),

      // Phase 2: Launch with Debug & Attach
      toolNode('launch-debug', 'electron_launch_debug', {
        input: { path: targetPath },
      }),
      toolNode('debug-status', 'electron_debug_status', { input: {} }),

      // Phase 3: Parallel IPC & Bridge Analysis
      parallelNode(
        'analyse-bridges',
        [
          toolNode('sniff-ipc', 'electron_ipc_sniff', {
            input: { duration: sniffDuration },
          }),
          toolNode('scan-userdata', 'electron_scan_userdata', { input: {} }),
          toolNode('search-preload', 'search_in_scripts', {
            input: {
              query: 'contextBridge,exposeInMainWorld,ipcRenderer,ipcMain,remote,nodeIntegration,preload,require',
              matchType: 'any',
            },
          }),
        ],
        maxConcurrency,
        false,
      ),

      // Phase 4: Bridge Surface Probe
      toolNode('probe-bridge', 'page_evaluate', {
        input: {
          expression: `(function() {
            const bridge = {};
            bridge.hasElectron = typeof process !== 'undefined' && !!process.versions?.electron;
            bridge.electronVersion = process?.versions?.electron || null;
            bridge.nodeVersion = process?.versions?.node || null;
            bridge.hasRequire = typeof require !== 'undefined';
            bridge.contextIsolation = null;
            bridge.nodeIntegration = typeof process !== 'undefined' && typeof require !== 'undefined';
            bridge.exposedAPIs = {};
            try {
              if (typeof window !== 'undefined') {
                for (const key of Object.keys(window)) {
                  const val = window[key];
                  if (val && typeof val === 'object' && key.startsWith('__') || key.includes('api') || key.includes('bridge') || key.includes('electron')) {
                    bridge.exposedAPIs[key] = Object.keys(val).slice(0, 20);
                  }
                }
              }
            } catch(e) {}
            return bridge;
          })()`,
        },
      }),
    ];

    // Phase 5: ASAR Extraction (Optional)
    if (extractAsar) {
      steps.push(
        toolNode('search-asar', 'asar_search', { input: {} }),
        toolNode('extract-asar', 'asar_extract', { input: {} }),
      );
    }

    // Phase 6: Evidence Recording
    steps.push(
      toolNode('create-evidence-session', 'instrumentation_session_create', {
        input: {
          name: `electron-bridge-${new Date().toISOString().slice(0, 10)}`,
          metadata: { targetPath, workflowId },
        },
      }),
      toolNode('record-artifact', 'instrumentation_artifact_record', {
        input: {
          type: 'electron_bridge_map',
          label: `Electron bridge analysis`,
          metadata: { targetPath, extractAsar },
        },
      }),

      // Phase 7: Session Insight
      toolNode('emit-insight', 'append_session_insight', {
        input: {
          insight: JSON.stringify({
            status: 'electron_bridge_mapper_complete',
            workflowId,
            targetPath,
            extractAsar,
          }),
        },
      }),
    );

    return sequenceNode('electron-bridge-mapper-root', steps);
  },

  onStart(ctx) {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, mission: 'electron_bridge_mapper', stage: 'start' });
  },
  onFinish(ctx) {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, mission: 'electron_bridge_mapper', stage: 'finish' });
  },
  onError(ctx, error) {
    ctx.emitMetric('workflow_errors_total', 1, 'counter', { workflowId, mission: 'electron_bridge_mapper', stage: 'error', error: error.name });
  },
};

export default electronBridgeMapperWorkflow;
