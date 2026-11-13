param([string]$OutDir,[string]$IcoPath)
Add-Type -AssemblyName System.Drawing
if(-not (Test-Path $OutDir)){New-Item -ItemType Directory -Path $OutDir -Force | Out-Null}
$sizes=@(16,24,32,48,64,128,256)
$pngs=@{}
foreach($s in $sizes){
  $bmp=New-Object System.Drawing.Bitmap($s,$s)
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $pad=[Math]::Max(0,[int]($s*0.02)); $r=[int]($s*0.20)
  $path=New-Object System.Drawing.Drawing2D.GraphicsPath
  $w=$s-2*$pad; $h=$s-2*$pad; $d=$r*2
  $path.AddArc($pad,$pad,$d,$d,180,90)
  $path.AddArc($pad+$w-$d,$pad,$d,$d,270,90)
  $path.AddArc($pad+$w-$d,$pad+$h-$d,$d,$d,0,90)
  $path.AddArc($pad,$pad+$h-$d,$d,$d,90,90)
  $path.CloseFigure()
  $bg=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,15,23,42))
  $g.FillPath($bg,$path)
  $rows=@(
    @{y=0.30;w=0.56;c=[System.Drawing.Color]::FromArgb(255,56,189,248)},
    @{y=0.46;w=0.38;c=[System.Drawing.Color]::FromArgb(255,56,189,248)},
    @{y=0.62;w=0.48;c=[System.Drawing.Color]::FromArgb(255,251,191,36)}
  )
  foreach($row in $rows){
    $left=[int]($s*0.22); $by=[int]($s*$row.y)
    $bw=[Math]::Max(2,[int]($s*$row.w)); $bh=[Math]::Max(1,[int]($s*0.09))
    $brush=New-Object System.Drawing.SolidBrush($row.c)
    $g.FillRectangle($brush,$left,$by,$bw,$bh)
    $brush.Dispose()
  }
  $g.Dispose()
  $ms=New-Object System.IO.MemoryStream
  $bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)
  $bytes=$ms.ToArray(); $ms.Dispose(); $bmp.Dispose()
  $pngs[$s]=$bytes
  [System.IO.File]::WriteAllBytes((Join-Path $OutDir ("icon-{0}.png" -f $s)),$bytes)
}
Write-Output ("rendered pngs {0}" -f $sizes.Count)
