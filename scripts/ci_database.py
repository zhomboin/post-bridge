"""仅为 GitHub CI 的专属临时数据库建立不绕过行权限的应用角色。"""

import os
import secrets
import subprocess
import urllib.parse

if os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("仅允许在 GitHub CI 的临时数据库运行")

connection = urllib.parse.urlsplit(os.environ["TEST_DATABASE_URL"])
password = secrets.token_urlsafe(32)
role = "post_bridge_app_test"
environment = {
    **os.environ,
    "PGPASSWORD": urllib.parse.unquote(connection.password or ""),
}
subprocess.run(
    [
        "psql",
        "--host",
        connection.hostname,
        "--port",
        str(connection.port or 5432),
        "--username",
        connection.username,
        "--dbname",
        connection.path.lstrip("/"),
        "--set",
        "ON_ERROR_STOP=1",
    ],
    input=(
        f"CREATE ROLE {role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{password}';\n"
        f"GRANT CREATE,CONNECT ON DATABASE {connection.path.lstrip('/')} TO {role};\n"
    ),
    text=True,
    env=environment,
    check=True,
    stdout=subprocess.DEVNULL,
)
url = urllib.parse.urlunsplit(
    connection._replace(
        netloc=f"{role}:{password}@{connection.hostname}:{connection.port or 5432}"
    )
)
with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
    stream.write("TEST_DATABASE_URL=" + url + "\n")
