#requires -Version 7.0
[CmdletBinding()]
param(
    [uri]$GeoServerUrl = 'http://127.0.0.1:8081/geoserver',
    [Parameter(Mandatory)][pscredential]$Credential
)

$ErrorActionPreference = 'Stop'
if ($GeoServerUrl.Scheme -ne 'https' -and -not $GeoServerUrl.IsLoopback) {
    throw 'Use HTTPS for a GeoServer outside this computer.'
}
$base = $GeoServerUrl.AbsoluteUri.TrimEnd('/')
$auth = @{ Authentication = 'Basic'; Credential = $Credential; TimeoutSec = 30 }
if ($GeoServerUrl.IsLoopback) {
    $auth.NoProxy = $true
    $auth.AllowUnencryptedAuthentication = $true
}
$styleName = 'province_outline_dynamic'
$stylesUrl = "$base/rest/workspaces/China/styles"
$styles = Invoke-RestMethod @auth -Uri "$stylesUrl.json"
$file = Join-Path $PSScriptRoot 'province_outline_dynamic.sld'
if (@($styles.styles.style).name -contains $styleName) {
    Invoke-RestMethod @auth -Method Put -Uri "$stylesUrl/$styleName" -ContentType 'application/vnd.ogc.sld+xml' -InFile $file | Out-Null
} else {
    Invoke-RestMethod @auth -Method Post -Uri "$stylesUrl`?name=$styleName" -ContentType 'application/vnd.ogc.sld+xml' -InFile $file | Out-Null
}

# Register as an alternate style, retaining the existing default and other styles.
$layerName = [uri]::EscapeDataString('China:中国省级行政区')
$layerUrl = "$base/rest/layers/$layerName.json"
$layer = (Invoke-RestMethod @auth -Uri $layerUrl).layer
$alternates = @($layer.styles.style | Where-Object { $null -ne $_ })
if (-not ($alternates | Where-Object { $_.name -in @($styleName, "China:$styleName") })) {
    $entries = @($alternates | ForEach-Object { @{ name = $_.name } })
    $entries += @{ name = "China:$styleName" }
    $body = @{ layer = @{ styles = @{ style = $entries } } } | ConvertTo-Json -Depth 8
    Invoke-RestMethod @auth -Method Put -Uri $layerUrl -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
}
Write-Output "Published China:$styleName as an alternate style."
