// Temperatures readable without admin, loaded by counters.ps1 with Add-Type -Path:
// the GPU perf data Task Manager shows, and the storage temperature property
// Settings > Disks shows. 0 means no sensor.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

public static class Temps {
  [StructLayout(LayoutKind.Sequential)] struct OPEN { public uint Low; public int High; public uint Adapter; }
  [StructLayout(LayoutKind.Sequential)] struct CLOSE { public uint Adapter; }
  [StructLayout(LayoutKind.Sequential)] struct QUERY { public uint Adapter; public int Type; public IntPtr Data; public uint Size; }

  [DllImport("gdi32.dll")] static extern int D3DKMTOpenAdapterFromLuid(ref OPEN o);
  [DllImport("gdi32.dll")] static extern int D3DKMTQueryAdapterInfo(ref QUERY q);
  [DllImport("gdi32.dll")] static extern int D3DKMTCloseAdapter(ref CLOSE c);

  const int KMTQAITYPE_ADAPTERPERFDATA = 62;
  const int PERFDATA_SIZE = 64;
  const int PERFDATA_TEMPERATURE = 56; // ULONG, deci-Celsius

  // luid as counters.ps1 emits it: luid_0x<high>_0x<low>
  public static double Gpu(string luid) {
    var parts = luid.Split('_');
    var open = new OPEN { High = Convert.ToInt32(parts[1], 16), Low = Convert.ToUInt32(parts[2], 16) };
    if (D3DKMTOpenAdapterFromLuid(ref open) != 0) return 0;
    IntPtr buf = Marshal.AllocHGlobal(PERFDATA_SIZE);
    try {
      for (int i = 0; i < PERFDATA_SIZE; i++) Marshal.WriteByte(buf, i, 0);
      var q = new QUERY { Adapter = open.Adapter, Type = KMTQAITYPE_ADAPTERPERFDATA, Data = buf, Size = PERFDATA_SIZE };
      if (D3DKMTQueryAdapterInfo(ref q) != 0) return 0;
      return Marshal.ReadInt32(buf, PERFDATA_TEMPERATURE) / 10.0;
    } finally {
      Marshal.FreeHGlobal(buf);
      var close = new CLOSE { Adapter = open.Adapter };
      D3DKMTCloseAdapter(ref close);
    }
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inBuf, int inLen, byte[] outBuf, int outLen, out int returned, IntPtr overlapped);
  // Reads the power state Windows tracks for the device; it sends nothing to the drive.
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetDevicePowerState(IntPtr h, out bool on);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint IOCTL_STORAGE_QUERY_PROPERTY = 0x2D1400;
  const int StorageDeviceProperty = 0;
  const int StorageDeviceSeekPenaltyProperty = 7;
  const int StorageDeviceTemperatureProperty = 52;
  public const int MinTicks = 10;
  public const int MaxDrives = 32;
  const int NEVER = int.MaxValue;

  // C = 0 means no reading. Idle: a spinning drive was left alone so it can spin down.
  // Mounts: drive letters with a volume on this disk.
  public class Disk { public int Index; public string Name; public int C; public bool Idle; public string[] Mounts = new string[0]; }

  public class Drive {
    public string Name;
    public bool Spins;
    public bool Unsupported;
    public bool HasReading;
    public int C;
    public int LastTick = -1;
  }

  static readonly Dictionary<int, Drive> drives = new Dictionary<int, Drive>();
  static Dictionary<int, List<string>> mounts;
  static int mountsTick;

  // Asking a spinning drive for its temperature sends it a command, which keeps it
  // from idling into standby. So a spinning drive is asked only while it is on and
  // already busy with real I/O, and never when active is null (the per-disk
  // counters are unavailable). Any drive is asked at most every MinTicks.
  public static bool ShouldQuery(bool spins, bool poweredOn, bool? active, int ticksSinceLast) {
    if (ticksSinceLast < MinTicks) return false;
    if (!spins) return true;
    if (!poweredOn || active == null) return false;
    return active.Value;
  }

  // Updates drive after this tick and returns its row. reading is the temperature
  // when queried and the query succeeded, otherwise null.
  public static Disk Record(Drive d, int n, int tick, bool queried, int? reading, bool? active) {
    var row = new Disk { Index = n, Name = d.Name };
    if (d.Unsupported) return row;
    int since = d.LastTick < 0 ? NEVER : tick - d.LastTick;
    if (queried) {
      d.LastTick = tick;
      if (reading.HasValue) {
        d.HasReading = true;
        d.C = reading.Value;
      } else if (!d.HasReading) {
        d.Unsupported = true; // never answered: no sensor or not supported (USB sticks)
        return row;
      }
      // A failed query after earlier readings keeps the last value and retries when due.
      row.C = d.C;
      return row;
    }
    if (d.HasReading) row.C = d.C;
    // Idle only once it was due and skipped, not between regular reads.
    row.Idle = d.Spins && active != null && since >= MinTicks;
    return row;
  }

  // Maps '\PhysicalDisk(<n> <letters>)\Disk Transfers/sec' instance names to drive
  // numbers. Returns null when there are no per-disk instances (counter unavailable).
  public static double[] Transfers(string[] instances, double[] values) {
    if (instances == null || values == null) return null;
    double[] result = null;
    for (int i = 0; i < instances.Length && i < values.Length; i++) {
      var m = Regex.Match(instances[i] ?? "", @"^(\d+)(\s|$)");
      if (!m.Success) continue;
      if (result == null) result = new double[MaxDrives];
      int n;
      if (int.TryParse(m.Groups[1].Value, out n) && n < MaxDrives) result[n] = values[i];
    }
    return result;
  }

  static byte[] Query(IntPtr h, int property) {
    var query = new byte[12]; // STORAGE_PROPERTY_QUERY: PropertyId, QueryType = 0, AdditionalParameters
    BitConverter.GetBytes(property).CopyTo(query, 0);
    var result = new byte[1024];
    int returned;
    return DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, query, query.Length, result, result.Length, out returned, IntPtr.Zero)
      ? result : null;
  }

  static Drive Describe(IntPtr h, int n) {
    // STORAGE_DEVICE_DESCRIPTOR: ProductIdOffset at 16, an ANSI string.
    var d = Query(h, StorageDeviceProperty);
    int offset = d == null ? 0 : BitConverter.ToInt32(d, 16);
    string name = "Disk " + n;
    if (offset > 0 && offset < d.Length) {
      int end = Array.IndexOf(d, (byte)0, offset);
      string product = System.Text.Encoding.ASCII.GetString(d, offset, (end < 0 ? d.Length : end) - offset).Trim();
      if (product.Length > 0) name = product;
    }
    // DEVICE_SEEK_PENALTY_DESCRIPTOR: IncursSeekPenalty at 8. Unknown counts as spinning.
    var s = Query(h, StorageDeviceSeekPenaltyProperty);
    return new Drive { Name = name, Spins = s == null || s[8] != 0 };
  }

  static int? ReadTemperature(IntPtr h) {
    // STORAGE_TEMPERATURE_DATA_DESCRIPTOR: InfoCount at 12, TemperatureInfo[0].Temperature at 26.
    var t = Query(h, StorageDeviceTemperatureProperty);
    if (t == null || BitConverter.ToUInt16(t, 12) == 0) return null;
    return BitConverter.ToInt16(t, 26);
  }

  const uint IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS = 0x560000;

  // Disk number -> drive letters, from each local volume's disk extents. The volume
  // manager answers this itself; nothing is sent to the disks.
  static Dictionary<int, List<string>> VolumeMounts() {
    var map = new Dictionary<int, List<string>>();
    foreach (var volume in System.IO.DriveInfo.GetDrives()) {
      if (volume.DriveType != System.IO.DriveType.Fixed && volume.DriveType != System.IO.DriveType.Removable) continue;
      string letter = volume.Name.Substring(0, 2);
      IntPtr h = CreateFile(@"\\.\" + letter, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (h == new IntPtr(-1)) continue;
      try {
        // VOLUME_DISK_EXTENTS: NumberOfDiskExtents at 0, then 24-byte DISK_EXTENTs from 8, DiskNumber first.
        var extents = new byte[1024];
        int returned;
        if (!DeviceIoControl(h, IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS, null, 0, extents, extents.Length, out returned, IntPtr.Zero)) continue;
        int count = Math.Min(BitConverter.ToInt32(extents, 0), (extents.Length - 8) / 24);
        for (int i = 0; i < count; i++) {
          int disk = BitConverter.ToInt32(extents, 8 + i * 24);
          List<string> letters;
          if (!map.TryGetValue(disk, out letters)) map[disk] = letters = new List<string>();
          if (!letters.Contains(letter)) letters.Add(letter);
        }
      } finally {
        CloseHandle(h);
      }
    }
    return map;
  }

  // transfers[n]: Disk Transfers/sec of PhysicalDrive<n> in the last sample (see Transfers).
  public static Disk[] Disks(int tick, double[] transfers) {
    if (mounts == null || tick - mountsTick >= MinTicks || tick < mountsTick) {
      mounts = VolumeMounts();
      mountsTick = tick;
    }
    var list = new List<Disk>();
    for (int n = 0; n < MaxDrives; n++) {
      // Access 0 is enough for property and power queries and needs no admin.
      IntPtr h = CreateFile(@"\\.\PhysicalDrive" + n, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (h == new IntPtr(-1)) {
        drives.Remove(n); // unplugged; a new device may take this number
        continue;
      }
      try {
        Drive drive;
        if (!drives.TryGetValue(n, out drive)) drives[n] = drive = Describe(h, n);
        bool on = true;
        if (drive.Spins && !GetDevicePowerState(h, out on)) on = false;
        bool? active = transfers == null ? (bool?)null : transfers[n] > 0;
        int since = drive.LastTick < 0 ? NEVER : tick - drive.LastTick;
        bool due = !drive.Unsupported && ShouldQuery(drive.Spins, on, active, since);
        var row = Record(drive, n, tick, due, due ? ReadTemperature(h) : null, active);
        List<string> letters;
        if (mounts.TryGetValue(n, out letters)) row.Mounts = letters.ToArray();
        list.Add(row);
      } finally {
        CloseHandle(h);
      }
    }
    return list.ToArray();
  }
}
