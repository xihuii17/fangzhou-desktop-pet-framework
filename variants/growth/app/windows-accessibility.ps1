# Windows PowerShell 5.1 has no managed LegacyIAccessiblePattern class.
# Read the documented MSAA interface through Accessibility.dll instead.
# This helper only reads player-owned windows; it never invokes UI actions.
if (-not ('PetMsaaReader' -as [type])) {
  Add-Type -AssemblyName Accessibility
  Add-Type -ReferencedAssemblies @('System.dll', 'System.Core.dll', [Accessibility.IAccessible].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;

public sealed class PetMsaaNode {
  public int id, parentId, role, state, x, y, width, height;
  public string name, value;
}
public sealed class PetMsaaSnapshot {
  public List<PetMsaaNode> nodes = new List<PetMsaaNode>();
  public List<string> errors = new List<string>();
  public List<string> windowClasses = new List<string>();
  public bool truncated;
  public int visited;
}
public static class PetMsaaReader {
  private delegate bool EnumWindow(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindow callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int length);
  [DllImport("oleacc.dll")] private static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);
  [DllImport("oleacc.dll")] private static extern int AccessibleChildren(IAccessible parent, int start, int count, [In, Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex=2)] object[] children, out int obtained);
  private sealed class Entry { public IAccessible acc; public int child, parent, depth; }
  private static string Limited(string value) { return value == null ? "" : value.Substring(0, Math.Min(value.Length, 1000)); }
  private static void Error(PetMsaaSnapshot result, string stage, Exception error) {
    if (result.errors.Count < 8) result.errors.Add(stage + ": " + error.Message);
  }
  public static PetMsaaSnapshot ReadWindow(long handle, int milliseconds, int maximum) {
    var result = new PetMsaaSnapshot();
    var watch = Stopwatch.StartNew();
    var windows = new List<IntPtr>();
    var owned = new HashSet<object>();
    var expanded = new HashSet<object>();
    windows.Add(new IntPtr(handle));
    EnumWindow callback = delegate(IntPtr child, IntPtr unused) {
      if (windows.Count >= 32 || watch.ElapsedMilliseconds >= milliseconds) { result.truncated = true; return false; }
      windows.Add(child); return true;
    };
    EnumChildWindows(new IntPtr(handle), callback, IntPtr.Zero);
    int identity = 0;
    try {
      foreach (var window in windows) {
        if (result.visited >= maximum || watch.ElapsedMilliseconds >= milliseconds) { result.truncated = true; break; }
        var caption = new StringBuilder(256); GetClassName(window, caption, caption.Capacity);
        string windowClass = caption.ToString();
        if (!result.windowClasses.Contains(windowClass)) result.windowClasses.Add(windowClass);
        Guid iid = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
        IAccessible root = null;
        // Chromium's documented assistive-technology detection uses object 1.
        // This requests an accessibility object; no flags, settings or actions change.
        if (windowClass.StartsWith("Chrome_RenderWidgetHost", StringComparison.Ordinal)) {
          IAccessible detection = null;
          try { AccessibleObjectFromWindow(window, 1, ref iid, out detection); if (detection != null) owned.Add(detection); } catch { }
        }
        try {
          int hr = AccessibleObjectFromWindow(window, 0xfffffffc, ref iid, out root);
          if (root != null) owned.Add(root);
          if (hr < 0 || root == null) {
            if (result.errors.Count < 8) result.errors.Add("window " + windowClass + ": HRESULT 0x" + hr.ToString("X8"));
            continue;
          }
        } catch (Exception error) { Error(result, "window", error); continue; }
        var queue = new Queue<Entry>();
        queue.Enqueue(new Entry { acc = root, child = 0, parent = -1, depth = 0 });
        while (queue.Count > 0) {
          if (result.visited >= maximum || watch.ElapsedMilliseconds >= milliseconds) { result.truncated = true; break; }
          Entry entry = queue.Dequeue();
          if (entry.child == 0 && !expanded.Add(entry.acc)) continue;
          result.visited++;
          var node = new PetMsaaNode { id = ++identity, parentId = entry.parent, name = "", value = "" };
          try { node.state = Convert.ToInt32(entry.acc.get_accState(entry.child)); } catch { }
          // Invisible/offscreen/protected controls must not be read or returned.
          if ((node.state & 0x20018000) != 0) continue;
          try { node.role = Convert.ToInt32(entry.acc.get_accRole(entry.child)); } catch { }
          try { node.name = Limited(entry.acc.get_accName(entry.child)); } catch { }
          try { node.value = Limited(entry.acc.get_accValue(entry.child)); } catch { }
          try { entry.acc.accLocation(out node.x, out node.y, out node.width, out node.height, entry.child); } catch { }
          result.nodes.Add(node);
          if (entry.child != 0 || entry.depth >= 20) continue;
          try {
            int childCount = entry.acc.accChildCount;
            int count = Math.Min(childCount, Math.Max(0, maximum - result.visited - queue.Count));
            if (count < childCount) result.truncated = true;
            if (count <= 0) continue;
            var children = new object[count]; int obtained;
            int hr = AccessibleChildren(entry.acc, 0, count, children, out obtained);
            if (hr < 0) continue;
            for (int index = 0; index < obtained; index++) {
              object child = children[index];
              var accessible = child as IAccessible;
              if (accessible != null) {
                owned.Add(accessible);
                queue.Enqueue(new Entry { acc = accessible, child = 0, parent = node.id, depth = entry.depth + 1 });
              } else if (child is int && (int)child != 0) {
                try { accessible = entry.acc.get_accChild(child) as IAccessible; } catch { }
                if (accessible != null) {
                  owned.Add(accessible);
                  queue.Enqueue(new Entry { acc = accessible, child = 0, parent = node.id, depth = entry.depth + 1 });
                } else {
                  // Simple child IDs are properties on their parent.
                  queue.Enqueue(new Entry { acc = entry.acc, child = (int)child, parent = node.id, depth = entry.depth + 1 });
                }
              }
            }
          } catch (Exception error) { Error(result, "children", error); }
        }
      }
    } finally {
      foreach (object obj in owned) {
        try { if (Marshal.IsComObject(obj)) Marshal.ReleaseComObject(obj); } catch { }
      }
    }
    return result;
  }
}
'@
}
function Select-PetClockNodes($nodes) {
  # Keep time/transport controls, their parents and a literal sibling separator.
  # QQ Music renders elapsed, slash and duration as three adjacent text nodes.
  $selected = @($nodes | Where-Object {
    $_.name -match '\d{1,3}:\d{2}|进度|^(播放|暂停|Play|Pause)$|progress|seek|timeline' -or
    $_.value -match '\d{1,3}:\d{2}' -or $_.role -in @(48, 51)
  } | Select-Object -First 64)
  $parentIds = @($selected | ForEach-Object { $_.parentId })
  @($nodes | Where-Object {
    $_ -in $selected -or $_.id -in $parentIds -or
    ($_.parentId -in $parentIds -and $_.role -in @(41, 61) -and $_.name -match '^\s*[/／]\s*$')
  } | Select-Object -First 96)
}
