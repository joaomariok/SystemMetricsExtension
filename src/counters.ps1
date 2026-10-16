# Streams JSON lines to stdout for src/winCounters.js:
#   1. once:  {"adapters":[{luid,name,software,dedicatedTotal,sharedTotal}]}
#   2. ~1/s:  {"samples":[{p,v}],"temps":{"gpu":{luid:celsius},"disks":[{index,name,c,idle,mounts}]}}
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Emit($obj) {
  # Parent gone (broken pipe) -> exit instead of looping forever as an orphan.
  try { [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject $obj)) } catch { exit }
}

$adapters = @()
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class Dxgi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DESC1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow;
    public int LuidHigh;
    public uint Flags;
  }

  [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFactory1 {
    // 9 inherited methods (IDXGIObject x4, IDXGIFactory x5) precede EnumAdapters1.
    void m0(); void m1(); void m2(); void m3(); void m4(); void m5(); void m6(); void m7(); void m8();
    [PreserveSig] int EnumAdapters1(uint index, out IAdapter1 adapter);
  }

  [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAdapter1 {
    // 7 inherited methods (IDXGIObject x4, IDXGIAdapter x3) precede GetDesc1.
    void m0(); void m1(); void m2(); void m3(); void m4(); void m5(); void m6();
    void GetDesc1(out DESC1 desc);
  }

  [DllImport("dxgi.dll")]
  static extern int CreateDXGIFactory1(ref Guid riid, out IFactory1 factory);

  public static DESC1[] List() {
    var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IFactory1 factory;
    if (CreateDXGIFactory1(ref iid, out factory) != 0) return new DESC1[0];
    var result = new List<DESC1>();
    IAdapter1 adapter;
    for (uint i = 0; factory.EnumAdapters1(i, out adapter) == 0; i++) {
      DESC1 d;
      adapter.GetDesc1(out d);
      result.Add(d);
    }
    return result.ToArray();
  }
}
'@
  $adapters = @([Dxgi]::List() | ForEach-Object {
    @{
      luid           = 'luid_0x{0:x8}_0x{1:x8}' -f $_.LuidHigh, $_.LuidLow
      name           = $_.Description
      software       = [bool]($_.Flags -band 2)
      dedicatedTotal = [double]$_.DedicatedVideoMemory.ToUInt64()
      sharedTotal    = [double]$_.SharedSystemMemory.ToUInt64()
    }
  })
} catch {}
Emit @{ adapters = $adapters }

# GPU and disk temperatures, readable without admin (see temps.cs).
$hasTemps = $false
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'temps.cs')
  $hasTemps = $true
} catch {}
$gpuLuids = @($adapters | Where-Object { -not $_.software } | ForEach-Object { $_.luid })
$diskTemps = @()
$tick = 0

$paths = @(
  '\GPU Engine(*engtype_3D)\Utilization Percentage',
  '\GPU Adapter Memory(*)\Dedicated Usage',
  '\GPU Adapter Memory(*)\Shared Usage',
  '\PhysicalDisk(_Total)\% Idle Time',
  '\PhysicalDisk(*)\Disk Transfers/sec',
  '\Network Interface(*)\Bytes Received/sec',
  '\Network Interface(*)\Bytes Sent/sec'
)

while ($true) {
  $raw = @()
  try {
    # Get-Counter waits one 1s sample interval, which paces the loop.
    $raw = @((Get-Counter -Counter $paths -ErrorAction SilentlyContinue).CounterSamples)
  } catch {}
  $samples = @($raw | ForEach-Object { @{ p = $_.Path; v = $_.CookedValue } })
  $gpuTemps = @{}
  if ($hasTemps) {
    foreach ($luid in $gpuLuids) { try { $gpuTemps[$luid] = [Temps]::Gpu($luid) } catch {} }
    $perDisk = @($raw | Where-Object { $_.Path -like '*\disk transfers/sec' })
    try {
      $transfers = [Temps]::Transfers([string[]]@($perDisk | ForEach-Object { $_.InstanceName }),
        [double[]]@($perDisk | ForEach-Object { $_.CookedValue }))
      $diskTemps = @([Temps]::Disks($tick, $transfers) |
        ForEach-Object { @{ index = $_.Index; name = $_.Name; c = $_.C; idle = $_.Idle; mounts = @($_.Mounts) } })
    } catch {}
  }
  $tick++
  Emit @{ samples = $samples; temps = @{ gpu = $gpuTemps; disks = $diskTemps } }
  if ($samples.Count -eq 0) { Start-Sleep -Seconds 1 }
}
