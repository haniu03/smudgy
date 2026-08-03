# spike-drag-repro.ps1 — the scripted pane-drag interaction regression matrix.
#
# Drives the unified Smudgy-owned drag controller with REAL synthesized mouse
# input (SetCursorPos + mouse_event — indistinguishable from hardware for
# capture semantics) and asserts every scenario against the controller's
# [pane-drag] log lines AND the post-drop layout dumps.
#
# Setup: SMUDGY_SPIKE_AUTOSESSION=2 opens two offline sessions (A, B) as two
# side-by-side clusters in the first window plus a second, empty window.
#
# Scenarios (scenario-legend ids in parentheses):
#   click-select     below-deadband click selects a tab (E1)
#   escape-pressed   Escape while pressed below deadband does nothing (E4b)
#   controls-noop    press on an embedded control never drags (E2)
#   merge-same       drag B onto A's header -> 2-tab group (T3)
#   reorder          drag B to slot 0 within the group (T1; keyed re-pair)
#   escape-cancel    Escape mid-drag cancels with zero mutation (E4)
#   ungroup          drag B to own group's bottom edge -> split (T10)
#   swap-same        drag B onto A's body center -> rendered swap (T5)
#   grid-edge        drag B to the grid's right edge band (T8)
#   adopt-empty      drag B into the empty second window (empty-window adopt)
#   swap-cross       drag B onto A's center across windows (T6)
#   split-cross      drag A onto B's left body edge across windows (T7)
#   tear-out         drag B onto the desktop -> new window (T12)
#   merge-cross      drag B from the torn-out window onto A's header (T4)
#
# Usage (from the worktree root):
#   powershell -ExecutionPolicy Bypass -File .\spike-drag-repro.ps1
#   powershell ... -KeepOpen              # leave the app running afterwards
#   powershell ... -SkipBuild             # reuse target\debug\smudgy.exe
#   powershell ... -Scenario merge-same   # run a single scenario by name
#
# Scenarios form a dependency chain (each aims at the layout its
# predecessors produced), so -Scenario is a debugging tool for gestures
# whose preconditions exist at startup — the early same-window rows; later
# rows may fail to aim when run alone.
param(
    [switch]$KeepOpen,
    [switch]$SkipBuild,
    [string]$Scenario = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $env:TEMP "smudgy-drag-matrix"
New-Item -ItemType Directory -Force $logDir | Out-Null
$stamp = Get-Date -Format "HHmmss"
$outLog = Join-Path $logDir "smudgy-$stamp.out.log"
$errLog = Join-Path $logDir "smudgy-$stamp.err.log"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SpikeInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$KEYEVENTF_KEYUP = 0x0002
$VK_ESCAPE = 0x1B
$SWP_NOZORDER_NOACTIVATE = 0x0014

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Marker([string]$text) {
    $t = Get-Date -Format "HH:mm:ss.fff"
    Write-Host "=== [$t] $text ==="
}

function Read-CleanLog {
    if (-not (Test-Path $errLog)) { return @() }
    # pretty_env_logger writes ANSI-styled lines to stderr; strip the escapes.
    $esc = [regex]::Escape([string][char]27) + "\[[0-9;]*m"
    @((Get-Content $errLog -ErrorAction SilentlyContinue) -replace $esc, "")
}

function Wait-ForLog([string]$pattern, [int]$timeoutSec, [string]$what) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $lines = Read-CleanLog | Select-String -Pattern $pattern
        if ($lines) { return $lines }
        Start-Sleep -Milliseconds 250
    }
    throw "timed out waiting for '$what' ($pattern) in $errLog"
}

function Step-Move([int]$x0, [int]$y0, [int]$x1, [int]$y1, [int]$steps, [int]$delayMs) {
    for ($i = 1; $i -le $steps; $i++) {
        $x = [int]($x0 + ($x1 - $x0) * $i / $steps)
        $y = [int]($y0 + ($y1 - $y0) * $i / $steps)
        [SpikeInput]::SetCursorPos($x, $y) | Out-Null
        Start-Sleep -Milliseconds $delayMs
    }
}

function Press-Escape {
    [SpikeInput]::keybd_event($VK_ESCAPE, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [SpikeInput]::keybd_event($VK_ESCAPE, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 250
}

# The latest laid-out bounds of one tab ("<sid>/pane#0"), window-local
# logical, from the controller's change-gated tab-bounds announcements
# (harness-gated: they log only under SMUDGY_SPIKE_AUTOSESSION).
# Optionally restricted to one window id label like "Id(3)".
$TabLine = "\[pane-drag\] tab TabId\(\d+\) \((\d+)/(pane#\d+)\) bounds window=(Id\(\d+\)): \(([-0-9.]+), ([-0-9.]+)\) ([0-9.]+)x([0-9.]+)$"
function Get-TabBounds([string]$label, [string]$windowId = "") {
    $hits = Read-CleanLog | Select-String -Pattern $TabLine | Where-Object {
        $m = [regex]::Match($_.Line, $TabLine)
        ("$($m.Groups[1].Value)/$($m.Groups[2].Value)" -eq $label) -and
        ($windowId -eq "" -or $m.Groups[3].Value -eq $windowId)
    }
    if (-not $hits) { throw "no tab-bounds log for $label (window '$windowId')" }
    $m = [regex]::Match($hits[-1].Line, $TabLine)
    @{
        Window = $m.Groups[3].Value
        X = [double]$m.Groups[4].Value; Y = [double]$m.Groups[5].Value
        W = [double]$m.Groups[6].Value; H = [double]$m.Groups[7].Value
    }
}

# The most recent layout dump for one window — the structural description
# the controller logs at every drag terminal (drops AND cancels). Feeds the
# zero-mutation (before == after) assertions.
function Get-LastLayout([string]$windowId) {
    $pattern = "\[pane-drag\] layout $([regex]::Escape($windowId)): (.*)$"
    $hits = Read-CleanLog | Select-String -Pattern $pattern
    if (-not $hits) { throw "no layout dump for $windowId yet" }
    [regex]::Match($hits[-1].Line, $pattern).Groups[1].Value
}

function Get-Rect([IntPtr]$hwnd) {
    $r = New-Object SpikeInput+RECT
    [SpikeInput]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $r
}

# Screen point of a tab's label surface (16 logical px into the tab).
function Tab-Point($tab) {
    $rect = Get-Rect $hwnds[$tab.Window]
    @(
        [int]($rect.Left + ($tab.X + 16) * $uiScale),
        [int]($rect.Top + ($tab.Y + $tab.H / 2) * $uiScale)
    )
}

# Screen point at a window fraction (of the whole window rect).
function Window-Point([string]$windowId, [double]$fx, [double]$fy) {
    $rect = Get-Rect $hwnds[$windowId]
    @(
        [int]($rect.Left + ($rect.Right - $rect.Left) * $fx),
        [int]($rect.Top + ($rect.Bottom - $rect.Top) * $fy)
    )
}

# Press a tab, cross the deadband, glide to the target, release (unless
# -NoRelease, for the Escape scenarios).
function Drag-Tab([string]$label, [string]$windowId, [int]$tx, [int]$ty, [switch]$NoRelease) {
    $tab = Get-TabBounds $label $windowId
    $p = Tab-Point $tab
    [SpikeInput]::SetCursorPos($p[0], $p[1]) | Out-Null
    Start-Sleep -Milliseconds 250
    [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 350
    # Cross the 10-logical-px deadband with a short diagonal.
    Step-Move $p[0] $p[1] ($p[0] + 30) ($p[1] + 30) 6 25
    Start-Sleep -Milliseconds 250
    Step-Move ($p[0] + 30) ($p[1] + 30) $tx $ty 30 15
    Start-Sleep -Milliseconds 400
    if (-not $NoRelease) {
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 700
    }
}

# --- scenario bookkeeping ---------------------------------------------------
$script:results = @()
$script:tailStart = 0

# Opens a scenario, or skips it (recorded as such) when -Scenario filters it
# out. Callers wrap the scenario body in `if (Begin-Scenario "name") { ... }`.
function Begin-Scenario([string]$name) {
    if ($Scenario -ne "" -and $Scenario -ne $name) {
        $script:results += [pscustomobject]@{ Scenario = $name; Result = "skip"; Detail = "filtered by -Scenario" }
        return $false
    }
    $script:tailStart = (Read-CleanLog).Count
    Marker "SCENARIO $name"
    return $true
}

function Get-Tail {
    $all = Read-CleanLog
    if ($all.Count -le $script:tailStart) { @() } else { $all[$script:tailStart..($all.Count - 1)] }
}

function Finish-Scenario([string]$name, [string[]]$expect, [string[]]$forbid) {
    $tail = Get-Tail
    $failed = @()
    foreach ($pattern in $expect) {
        if (-not ($tail | Select-String -Pattern $pattern)) { $failed += "missing: $pattern" }
    }
    foreach ($pattern in $forbid) {
        if ($tail | Select-String -Pattern $pattern) { $failed += "forbidden: $pattern" }
    }
    if ($failed) {
        $script:results += [pscustomobject]@{ Scenario = $name; Result = "FAIL"; Detail = ($failed -join "; ") }
        Marker "FAIL $name -> $($failed -join '; ')"
    } else {
        $script:results += [pscustomobject]@{ Scenario = $name; Result = "ok"; Detail = "" }
        Marker "ok $name"
    }
}

# ---------------------------------------------------------------------------
# 1. Build + launch
# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
    Marker "cargo build"
    Push-Location $root
    try {
        # cmd wrapper: cargo's stderr progress must not become PowerShell
        # ErrorRecords under $ErrorActionPreference = "Stop".
        cmd /c "cargo build --locked 2>&1" | Select-Object -Last 3 | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
    } finally { Pop-Location }
}
$exe = Join-Path $root "target\debug\smudgy.exe"
if (-not (Test-Path $exe)) { throw "missing $exe" }

$env:SMUDGY_SPIKE_AUTOSESSION = "2"
$env:SMUDGY_LOG = "info"
Marker "launching $exe (stderr -> $errLog)"
$proc = Start-Process -FilePath $exe -WorkingDirectory $root `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru

try {
    # -----------------------------------------------------------------------
    # 2. Discover windows, sessions, tabs
    # -----------------------------------------------------------------------
    $hwndLine = "\[pane-drag\] window (Id\(\d+\)) hwnd=(0x[0-9a-fA-F]+)$"
    $hwndLines = Wait-ForLog $hwndLine 90 "two window hwnds"
    $deadline = (Get-Date).AddSeconds(60)
    while ($hwndLines.Count -lt 2 -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $hwndLines = Read-CleanLog | Select-String $hwndLine
    }
    if ($hwndLines.Count -lt 2) { throw "expected 2 windows, saw $($hwndLines.Count)" }

    $hwnds = @{}
    function Refresh-Hwnds {
        foreach ($line in (Read-CleanLog | Select-String $hwndLine)) {
            $m = [regex]::Match($line.Line, $hwndLine)
            $hwnds[$m.Groups[1].Value] = [IntPtr][Convert]::ToInt64($m.Groups[2].Value, 16)
        }
    }
    Refresh-Hwnds
    $sourceLine = Wait-ForLog "autosession: opening .* in (Id\(\d+\))" 30 "autosession source id"
    $w1 = [regex]::Match($sourceLine[0].Line, "in (Id\(\d+\))").Groups[1].Value
    $w2 = ($hwnds.Keys | Where-Object { $_ -ne $w1 }) | Select-Object -First 1
    Marker "source $w1, second $w2"

    # Both sessions' main tabs must have laid out.
    Wait-ForLog $TabLine 30 "tab bounds" | Out-Null
    $deadline = (Get-Date).AddSeconds(30)
    do {
        $labels = @(Read-CleanLog | Select-String $TabLine | ForEach-Object {
            $m = [regex]::Match($_.Line, $TabLine)
            "$($m.Groups[1].Value)/$($m.Groups[2].Value)"
        } | Sort-Object -Unique)
        if ($labels.Count -ge 2) { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if ($labels.Count -lt 2) { throw "expected two session tabs, saw: $($labels -join ', ')" }
    $sids = $labels | ForEach-Object { [int]($_ -split "/")[0] } | Sort-Object
    $A = "$($sids[0])/pane#0"
    $B = "$($sids[1])/pane#0"
    Marker "sessions: A=$A (left cluster), B=$B (right cluster)"

    # -----------------------------------------------------------------------
    # 3. Arrange windows and calibrate the input scale
    # -----------------------------------------------------------------------
    $dpi = [SpikeInput]::GetDpiForWindow($hwnds[$w1])
    $scale = $dpi / 96.0
    $screenW = [SpikeInput]::GetSystemMetrics(0)
    $screenH = [SpikeInput]::GetSystemMetrics(1)
    $srcW = [int](900 * $scale); $srcH = [int](540 * $scale)
    $secW = [int](660 * $scale); $secH = [int](430 * $scale)
    $gap = 50
    if (40 + $srcW + $gap + $secW + 40 -gt $screenW) {
        throw "screen too narrow for side-by-side layout ($screenW px)"
    }
    [SpikeInput]::SetWindowPos($hwnds[$w1], [IntPtr]::Zero, 40, 40, $srcW, $srcH, $SWP_NOZORDER_NOACTIVATE) | Out-Null
    [SpikeInput]::SetWindowPos($hwnds[$w2], [IntPtr]::Zero, 40 + $srcW + $gap, 40, $secW, $secH, $SWP_NOZORDER_NOACTIVATE) | Out-Null
    Start-Sleep -Milliseconds 800

    $desktopY = 40 + [Math]::Max($srcH, $secH) + 140
    if ($desktopY -gt $screenH - 90) { throw "no empty desktop below the windows" }

    # Calibrate: powershell.exe is usually system-DPI-virtualized, making its
    # coordinates 1:1 with iced-logical units; a fully DPI-aware host needs
    # dpi/96. Probe-click A's tab (a harmless click-select) and let the app's
    # own press log confirm the hit.
    $uiScale = 0
    foreach ($cand in @(1.0, ($dpi / 96.0)) | Select-Object -Unique) {
        $uiScale = $cand
        $tab = Get-TabBounds $A $w1
        $p = Tab-Point $tab
        $before = (Read-CleanLog | Select-String "\[pane-drag\] press ").Count
        [SpikeInput]::SetCursorPos($p[0], $p[1]) | Out-Null
        Start-Sleep -Milliseconds 200
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 250
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 350
        if ((Read-CleanLog | Select-String "\[pane-drag\] press ").Count -gt $before) {
            Marker "tab press located at ($($p[0]), $($p[1])), ui scale $uiScale"
            break
        }
        $uiScale = 0
    }
    if ($uiScale -eq 0) { throw "could not locate a tab by probe-clicking" }

    # Header drop y: the lower part of a tab (near its bottom edge) — above
    # it, the whole-grid TOP edge band (native precedence, min/25 depth)
    # outranks the header band for top-row panes.
    function Header-Y($tab, $rect) {
        [int]($rect.Top + ($tab.Y + $tab.H - 3) * $uiScale)
    }

    # -----------------------------------------------------------------------
    # 4. Scenarios
    # -----------------------------------------------------------------------

    # E1: a below-deadband click selects the tab.
    if (Begin-Scenario "click-select") {
        $tab = Get-TabBounds $B $w1
        $p = Tab-Point $tab
        [SpikeInput]::SetCursorPos($p[0], $p[1]) | Out-Null
        Start-Sleep -Milliseconds 200
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 200
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 500
        Finish-Scenario "click-select" `
            @("\[pane-drag\] click-select tab TabId\(\d+\)`$") `
            @("\[pane-drag\] drag started", "\[pane-drag\] drop:")
    }

    # E4b: Escape while pressed below the deadband does nothing; the press
    # continues and the release still classifies as a click.
    if (Begin-Scenario "escape-pressed") {
        $tab = Get-TabBounds $A $w1
        $p = Tab-Point $tab
        [SpikeInput]::SetCursorPos($p[0], $p[1]) | Out-Null
        Start-Sleep -Milliseconds 200
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 250
        Press-Escape
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 500
        Finish-Scenario "escape-pressed" `
            @("\[pane-drag\] click-select tab TabId\(\d+\)`$") `
            @("\[pane-drag\] cancel", "\[pane-drag\] drag started")
    }

    # E2: a press on an embedded control (the visibility eye, the trailing
    # control) belongs to the control and never engages the drag machinery —
    # even when the pointer then travels a full drag's distance. Releasing
    # off the control also keeps the control from firing, so the scenario
    # mutates nothing.
    if (Begin-Scenario "controls-noop") {
        $tab = Get-TabBounds $B $w1
        $rect = Get-Rect $hwnds[$tab.Window]
        $cx = [int]($rect.Left + ($tab.X + $tab.W - 12) * $uiScale)
        $cy = [int]($rect.Top + ($tab.Y + $tab.H / 2) * $uiScale)
        [SpikeInput]::SetCursorPos($cx, $cy) | Out-Null
        Start-Sleep -Milliseconds 200
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 300
        Step-Move $cx $cy $cx ($cy + 120) 10 20
        Start-Sleep -Milliseconds 300
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 500
        Finish-Scenario "controls-noop" `
            @() `
            @("\[pane-drag\] press ", "\[pane-drag\] drag started", "\[pane-drag\] drop:",
              "\[pane-drag\] click-select")
    }

    # T3: drag B's tab onto A's header -> B merges into A's group at the end
    # of the strip; the moved tab is selected there.
    if (Begin-Scenario "merge-same") {
        $tabA = Get-TabBounds $A $w1
        $rect = Get-Rect $hwnds[$w1]
        $tx = [int]($rect.Left + ($tabA.X + $tabA.W + 40) * $uiScale)
        $ty = Header-Y $tabA $rect
        Drag-Tab $B $w1 $tx $ty
        Finish-Scenario "merge-same" `
            @("\[pane-drag\] drop: merge tab .* \(same window\)`$",
              "\[pane-drag\] layout $([regex]::Escape($w1)): \[$([regex]::Escape("$A $B*"))\]`$",
              "\[pane-drag\] layout $([regex]::Escape($w2)): `$") `
            @("cross-window")
    }

    # T1: reorder within the group — drag B (slot 1) to slot 0. The keyed
    # body host re-pairs each subtree with its moved tab; post-state asserts
    # the new strip order with B still selected.
    if (Begin-Scenario "reorder") {
        $tabA = Get-TabBounds $A $w1
        $rect = Get-Rect $hwnds[$w1]
        # Left of A's tab center (slot 0) but clear of the grid's LEFT edge
        # band, which outranks the header at the extreme rim.
        $tx = [int]($rect.Left + ($tabA.X + 40) * $uiScale)
        $ty = Header-Y $tabA $rect
        Drag-Tab $B $w1 $tx $ty
        Finish-Scenario "reorder" `
            @("\[pane-drag\] drop: merge tab .* at slot 0 \(same window\)`$",
              "\[pane-drag\] layout $([regex]::Escape($w1)): \[$([regex]::Escape("$B* $A"))\]`$") `
            @()
    }

    # E4: Escape mid-drag cancels with zero mutation — asserted structurally:
    # the post-cancel layout dump must equal the last dump before the drag.
    if (Begin-Scenario "escape-cancel") {
        $layoutBefore = Get-LastLayout $w1
        $mid = Window-Point $w1 0.5 0.6
        Drag-Tab $B $w1 $mid[0] $mid[1] -NoRelease
        Press-Escape
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 500
        Finish-Scenario "escape-cancel" `
            @("\[pane-drag\] drag started",
              "\[pane-drag\] cancel \(escape\)",
              "\[pane-drag\] layout $([regex]::Escape($w1)): $([regex]::Escape($layoutBefore))`$") `
            @("\[pane-drag\] drop:")
    }

    # T10: drag B to its own group's bottom body edge -> ungroup into a
    # singleton split below.
    if (Begin-Scenario "ungroup") {
        $edge = Window-Point $w1 0.5 0.93
        Drag-Tab $B $w1 $edge[0] $edge[1]
        Finish-Scenario "ungroup" `
            @("\[pane-drag\] drop: split tab .* \(Bottom\)`$",
              "\[pane-drag\] layout $([regex]::Escape($w1)): \[$([regex]::Escape("$A*"))\]\[$([regex]::Escape("$B*"))\]`$") `
            @("cross-window")
    }

    # T5: drag B (bottom pane) onto A's body center -> atomic rendered-tab
    # swap; the two panes trade places (bindings swap, groups stay put).
    if (Begin-Scenario "swap-same") {
        $center = Window-Point $w1 0.5 0.33
        Drag-Tab $B $w1 $center[0] $center[1]
        Finish-Scenario "swap-same" `
            @("\[pane-drag\] drop: swap $([regex]::Escape($B)) with rendered $([regex]::Escape($A))`$",
              "\[pane-drag\] layout $([regex]::Escape($w1)): \[$([regex]::Escape("$B*"))\]\[$([regex]::Escape("$A*"))\]`$",
              "\[pane-drag\] layout $([regex]::Escape($w2)): `$") `
            @()
    }

    # T8: drag B (now the top pane) to the grid's right edge band -> new
    # trailing top-level cluster.
    if (Begin-Scenario "grid-edge") {
        $band = Window-Point $w1 0.992 0.5
        Drag-Tab $B $w1 $band[0] $band[1]
        Finish-Scenario "grid-edge" `
            @("\[pane-drag\] drop: grid edge Right \(same window\)`$",
              "\[pane-drag\] layout $([regex]::Escape($w1)): \[$([regex]::Escape("$A*"))\]\[$([regex]::Escape("$B*"))\]`$",
              "\[pane-drag\] layout $([regex]::Escape($w2)): `$") `
            @()
    }

    # Empty-window adopt: drag B into the empty second window -> it becomes
    # that window's first cluster and leaves the source entirely.
    if (Begin-Scenario "adopt-empty") {
        $target = Window-Point $w2 0.5 0.6
        Drag-Tab $B $w1 $target[0] $target[1]
        Finish-Scenario "adopt-empty" `
            @("\[pane-drag\] drop: adopt into empty window $([regex]::Escape($w2))`$",
              "\[pane-drag\] layout $([regex]::Escape($w1)): \[$([regex]::Escape("$A*"))\]`$",
              "\[pane-drag\] layout $([regex]::Escape($w2)): \[$([regex]::Escape("$B*"))\]`$") `
            @("\[pane-drag\] layout $([regex]::Escape($w1)): .*$([regex]::Escape($B))")
    }

    # T6: drag B (now in the second window) onto A's body center in the
    # first -> the cross-window atomic swap; the panes trade windows.
    if (Begin-Scenario "swap-cross") {
        $center = Window-Point $w1 0.5 0.6
        Drag-Tab $B $w2 $center[0] $center[1]
        Finish-Scenario "swap-cross" `
            @("\[pane-drag\] drop: swap $([regex]::Escape($B)) with rendered $([regex]::Escape($A))`$",
              "\[pane-drag\] layout $([regex]::Escape($w1)): \[$([regex]::Escape("$B*"))\]`$",
              "\[pane-drag\] layout $([regex]::Escape($w2)): \[$([regex]::Escape("$A*"))\]`$") `
            @("\[pane-drag\] layout $([regex]::Escape($w2)): .*$([regex]::Escape($B))")
    }

    if (Begin-Scenario "split-cross") {
        # A cross-window swap exchanges pane BINDINGS: the destination tab
        # keeps its id but now fronts the other pane, and the app
        # re-announces its bounds under the new label on the next paint —
        # wait for that before aiming at A in the second window.
        Wait-ForLog "tab TabId\(\d+\) \($([regex]::Escape($A))\) bounds window=$([regex]::Escape($w2))" 15 "A's tab re-announced in the second window" | Out-Null

        # T7: drag A (in the second window) onto the left body edge of B's
        # pane in the first -> a cross-window split; the second window
        # empties and closes by the empty-window rule.
        $edge = Window-Point $w1 0.12 0.6
        Drag-Tab $A $w2 $edge[0] $edge[1]
        Finish-Scenario "split-cross" `
            @("\[pane-drag\] drop: split tab .* \(Left, cross-window\)`$",
              "\[pane-drag\] layout $([regex]::Escape($w1)): \[$([regex]::Escape("$A*"))\]\[$([regex]::Escape("$B*"))\]`$") `
            @("\[pane-drag\] layout $([regex]::Escape($w2)): .*$([regex]::Escape($A))")
        Start-Sleep -Milliseconds 800   # let the emptied second window close
    }

    # T12: drag B onto the desktop below -> tear out into a new window. The
    # terminal's layout dump already includes the synchronously inserted
    # torn-out window, so the new singleton is asserted before its hwnd is
    # even known.
    $w3 = $null
    if (Begin-Scenario "tear-out") {
        $rect = Get-Rect $hwnds[$w1]
        $dx = [int](($rect.Left + $rect.Right) / 2)
        Drag-Tab $B $w1 $dx $desktopY
        Start-Sleep -Milliseconds 800
        Refresh-Hwnds
        $w3 = ($hwnds.Keys | Where-Object { $_ -ne $w1 -and $_ -ne $w2 }) | Select-Object -First 1
        Finish-Scenario "tear-out" `
            @("\[pane-drag\] drop: tear out $([regex]::Escape($B)) into a new window`$",
              "\[pane-drag\] layout $([regex]::Escape($w1)): \[$([regex]::Escape("$A*"))\]`$",
              "\[pane-drag\] layout Id\(\d+\): \[$([regex]::Escape("$B*"))\]`$") `
            @("\[pane-drag\] layout $([regex]::Escape($w1)): .*$([regex]::Escape($B))")
        if (-not $w3) { throw "tear-out window never announced its hwnd" }
        Marker "torn-out window: $w3"
    }

    # T4: drag A from the first window onto the torn-out window's header.
    # The torn-out singleton starts headerless (collapsed toolbar; the
    # header-hiding preference may be on), so this lands on the TEMPORARY
    # header band every eligible target exposes while a drag is live —
    # asserting the hidden-header band rule and the cross-window merge in
    # one gesture. Two phases: dwell over the torn-out window so the
    # temporary band mounts and announces its live geometry, then aim the
    # release from those bounds (chrome height varies with banners, so no
    # estimate survives contact). The first window empties and closes; the
    # merged group lives in the torn-out window with the moved tab selected.
    if (Begin-Scenario "merge-cross") {
        $tabA = Get-TabBounds $A $w1
        $p = Tab-Point $tabA
        $rect3 = Get-Rect $hwnds[$w3]
        $mid3 = @([int](($rect3.Left + $rect3.Right) / 2), [int](($rect3.Top + $rect3.Bottom) / 2))
        [SpikeInput]::SetCursorPos($p[0], $p[1]) | Out-Null
        Start-Sleep -Milliseconds 250
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 350
        Step-Move $p[0] $p[1] ($p[0] + 30) ($p[1] + 30) 6 25
        Step-Move ($p[0] + 30) ($p[1] + 30) $mid3[0] $mid3[1] 30 15
        Start-Sleep -Milliseconds 600
        $tabB3 = Get-TabBounds $B $w3
        $tx = [int]($rect3.Left + ($tabB3.X + $tabB3.W + 30) * $uiScale)
        $ty = [int]($rect3.Top + ($tabB3.Y + $tabB3.H - 3) * $uiScale)
        Step-Move $mid3[0] $mid3[1] $tx $ty 15 20
        Start-Sleep -Milliseconds 400
        [SpikeInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 700
        Finish-Scenario "merge-cross" `
            @("\[pane-drag\] drop: merge tab .* \(cross-window\)`$",
              "\[pane-drag\] layout $([regex]::Escape($w3)): \[$([regex]::Escape("$B $A*"))\]`$") `
            @("\[pane-drag\] layout $([regex]::Escape($w1)): .*$([regex]::Escape($A))")
    }

    # -----------------------------------------------------------------------
    # 5. Report
    # -----------------------------------------------------------------------
    Start-Sleep -Milliseconds 400
    Marker "scenario results"
    $script:results | Format-Table -AutoSize | Out-String | Write-Host
    Marker "full logs: $errLog"
    $failCount = @($script:results | Where-Object { $_.Result -eq "FAIL" }).Count
    if ($failCount -gt 0) {
        Marker "[pane-drag] log tail for diagnosis"
        Read-CleanLog | Select-String "\[pane-drag\]" | Select-Object -Last 80 | ForEach-Object { $_.Line } | Write-Host
        throw "$failCount scenario(s) failed"
    }
    Marker "ALL SCENARIOS PASSED"
} finally {
    if (-not $KeepOpen -and $proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -Confirm:$false
    }
}
