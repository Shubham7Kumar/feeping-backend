
$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:5001/api/v1"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$securePassword = Read-Host "Staging test account password" -AsSecureString

try {
    $testPassword = [System.Net.NetworkCredential]::new(
        "",
        $securePassword
    ).Password

    $registerBody = @{
        organizationName = "FeePing E2E Academy"
        name = "Test Owner"
        email = "owner-e2e-2026@example.com"
        password = $testPassword
    } | ConvertTo-Json

    Write-Host "`n1. Registering organization..."

    try {
        $registration = Invoke-RestMethod `
            -Uri "$baseUrl/auth/register" `
            -Method Post `
            -ContentType "application/json" `
            -Body $registerBody

        $registration | ConvertTo-Json -Depth 5
    }
    catch {
        Write-Host "Registration failed. The account may already exist."
        throw
    }

    Write-Host "`n2. Logging in..."

    $loginBody = @{
        email = "owner-e2e-2026@example.com"
        password = $testPassword
    } | ConvertTo-Json

    $login = Invoke-RestMethod `
        -Uri "$baseUrl/auth/login" `
        -Method Post `
        -ContentType "application/json" `
        -Body $loginBody `
        -WebSession $session

    Write-Host "Login successful."

    Write-Host "`n3. Checking authenticated user..."

    $me = Invoke-RestMethod `
        -Uri "$baseUrl/auth/me" `
        -Method Get `
        -WebSession $session

    $me | ConvertTo-Json -Depth 5
}
finally {
    $testPassword = $null
    $registerBody = $null
    $loginBody = $null

    if ($securePassword) {
        $securePassword.Dispose()
        $securePassword = $null
    }
}
