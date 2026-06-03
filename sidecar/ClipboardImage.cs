using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace FlaUiSidecar;

/// <summary>
/// Image clipboard get/set via Win32 clipboard P/Invoke (no WinForms — keeps the Microsoft.NET.Sdk.Web /
/// net8.0-windows build clean, ADR constraint). Images are exchanged with the driver as PNG bytes; on the
/// Windows clipboard they live as CF_DIB (the universally-pasteable bitmap format). Conversion between PNG
/// and DIB uses System.Drawing.Bitmap (available on the net8.0-windows TFM).
///
/// MUST be called on an STA thread — the UIA scheduler worker already is, and all ops run there.
/// </summary>
internal static class ClipboardImage
{
    private const uint CF_DIB = 8;
    private const uint GMEM_MOVEABLE = 0x0002;

    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalFree(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern UIntPtr GlobalSize(IntPtr hMem);

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    /// <summary>Read the clipboard image (CF_DIB) and return it as PNG bytes, or null if no image present.</summary>
    public static byte[]? GetPng()
    {
        if (!OpenClipboard(IntPtr.Zero)) return null;
        try
        {
            var hDib = GetClipboardData(CF_DIB);
            if (hDib == IntPtr.Zero) return null;

            var ptr = GlobalLock(hDib);
            if (ptr == IntPtr.Zero) return null;
            try
            {
                var size = (int)GlobalSize(hDib);
                if (size <= 0) return null;
                var dib = new byte[size];
                Marshal.Copy(ptr, dib, 0, size);
                using var bmp = DibToBitmap(dib);
                if (bmp is null) return null;
                using var ms = new MemoryStream();
                bmp.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
            finally { GlobalUnlock(hDib); }
        }
        finally { CloseClipboard(); }
    }

    /// <summary>Put a PNG image (given as bytes) onto the clipboard as CF_DIB.</summary>
    public static void SetPng(byte[] png)
    {
        using var ms = new MemoryStream(png);
        using var bmp = new Bitmap(ms);
        var dib = BitmapToDib(bmp);

        if (!OpenClipboard(IntPtr.Zero)) throw new InvalidOperationException("could not open clipboard");
        try
        {
            EmptyClipboard();
            var hGlobal = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)dib.Length);
            if (hGlobal == IntPtr.Zero) throw new InvalidOperationException("GlobalAlloc failed");
            var locked = GlobalLock(hGlobal);
            if (locked == IntPtr.Zero) { GlobalFree(hGlobal); throw new InvalidOperationException("GlobalLock failed"); }
            try { Marshal.Copy(dib, 0, locked, dib.Length); }
            finally { GlobalUnlock(hGlobal); }

            if (SetClipboardData(CF_DIB, hGlobal) == IntPtr.Zero)
            {
                GlobalFree(hGlobal);
                throw new InvalidOperationException("SetClipboardData failed");
            }
            // Ownership of hGlobal transfers to the clipboard on success — do not free.
        }
        finally { CloseClipboard(); }
    }

    /// <summary>Convert a 32bpp ARGB Bitmap to a packed DIB (BITMAPINFOHEADER + bottom-up BGRA rows).</summary>
    private static byte[] BitmapToDib(Bitmap source)
    {
        using var bmp = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            g.DrawImage(source, 0, 0, source.Width, source.Height);
        }

        var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
        var data = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var stride = data.Stride;
            var height = bmp.Height;
            var pixelBytes = stride * height;
            var headerSize = Marshal.SizeOf<BITMAPINFOHEADER>();
            var dib = new byte[headerSize + pixelBytes];

            var header = new BITMAPINFOHEADER
            {
                biSize = (uint)headerSize,
                biWidth = bmp.Width,
                biHeight = bmp.Height, // positive => bottom-up
                biPlanes = 1,
                biBitCount = 32,
                biCompression = 0, // BI_RGB
                biSizeImage = (uint)pixelBytes,
            };
            var headerBytes = StructToBytes(header);
            Buffer.BlockCopy(headerBytes, 0, dib, 0, headerSize);

            // GDI scanlines are already bottom-up in memory for a positive-height DIB only when we copy
            // them in reverse row order. LockBits gives top-down rows, so flip them here.
            for (var y = 0; y < height; y++)
            {
                var srcRow = data.Scan0 + (height - 1 - y) * stride;
                var rowBuf = new byte[stride];
                Marshal.Copy(srcRow, rowBuf, 0, stride);
                Buffer.BlockCopy(rowBuf, 0, dib, headerSize + y * stride, stride);
            }
            return dib;
        }
        finally { bmp.UnlockBits(data); }
    }

    /// <summary>Reconstruct a Bitmap from a packed DIB (BITMAPINFOHEADER + pixel rows).</summary>
    private static Bitmap? DibToBitmap(byte[] dib)
    {
        var headerSize = Marshal.SizeOf<BITMAPINFOHEADER>();
        if (dib.Length < headerSize) return null;
        var header = BytesToStruct<BITMAPINFOHEADER>(dib);
        var width = header.biWidth;
        var height = Math.Abs(header.biHeight);
        var topDown = header.biHeight < 0;
        var bpp = header.biBitCount;
        if (width <= 0 || height <= 0) return null;
        // Color table size (for <= 8bpp). For 24/32bpp typically 0 unless biClrUsed set.
        var paletteEntries = bpp <= 8 ? (header.biClrUsed != 0 ? (int)header.biClrUsed : 1 << bpp) : (int)header.biClrUsed;
        var pixelOffset = headerSize + paletteEntries * 4;
        if (dib.Length < pixelOffset) return null;

        // Handle the common 32bpp and 24bpp BI_RGB cases directly.
        if ((bpp == 32 || bpp == 24) && header.biCompression == 0)
        {
            var pf = bpp == 32 ? PixelFormat.Format32bppArgb : PixelFormat.Format24bppRgb;
            var bmp = new Bitmap(width, height, pf);
            var rect = new Rectangle(0, 0, width, height);
            var bd = bmp.LockBits(rect, ImageLockMode.WriteOnly, pf);
            try
            {
                var stride = Math.Abs(bd.Stride);
                for (var y = 0; y < height; y++)
                {
                    var srcRowIndex = topDown ? y : height - 1 - y;
                    var srcStart = pixelOffset + srcRowIndex * stride;
                    if (srcStart + stride > dib.Length) break;
                    var dstRow = bd.Scan0 + y * bd.Stride;
                    Marshal.Copy(dib, srcStart, dstRow, stride);
                }
            }
            finally { bmp.UnlockBits(bd); }
            return bmp;
        }

        // Fallback: prepend a BITMAPFILEHEADER and let GDI+ decode (handles odd bpp/compression).
        return DibToBitmapViaFileHeader(dib, pixelOffset);
    }

    private static Bitmap DibToBitmapViaFileHeader(byte[] dib, int pixelOffset)
    {
        const int fileHeaderSize = 14;
        var fileBytes = new byte[fileHeaderSize + dib.Length];
        fileBytes[0] = (byte)'B';
        fileBytes[1] = (byte)'M';
        BitConverter.GetBytes(fileBytes.Length).CopyTo(fileBytes, 2);          // bfSize
        BitConverter.GetBytes(fileHeaderSize + pixelOffset).CopyTo(fileBytes, 10); // bfOffBits
        Buffer.BlockCopy(dib, 0, fileBytes, fileHeaderSize, dib.Length);
        using var ms = new MemoryStream(fileBytes);
        return new Bitmap(ms);
    }

    private static byte[] StructToBytes<T>(T value) where T : struct
    {
        var size = Marshal.SizeOf<T>();
        var arr = new byte[size];
        var ptr = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(value, ptr, false); Marshal.Copy(ptr, arr, 0, size); }
        finally { Marshal.FreeHGlobal(ptr); }
        return arr;
    }

    private static T BytesToStruct<T>(byte[] bytes) where T : struct
    {
        var size = Marshal.SizeOf<T>();
        var ptr = Marshal.AllocHGlobal(size);
        try { Marshal.Copy(bytes, 0, ptr, size); return Marshal.PtrToStructure<T>(ptr); }
        finally { Marshal.FreeHGlobal(ptr); }
    }
}
