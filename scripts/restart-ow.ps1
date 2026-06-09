$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'openwriter' }
foreach ($p in $procs) {
  Write-Output "KILLING $($p.ProcessId) :: $($p.CommandLine)"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if (-not $procs) { Write-Output "No openwriter node processes found." }
