import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import server


class GatewayAccessTests(unittest.TestCase):
    def test_hosted_gateway_rejects_missing_or_wrong_token(self):
        with patch.dict(os.environ, {"ROBOT_WEB_TOKEN": "test-gateway-secret"}):
            with TestClient(server.api) as client:
                self.assertEqual(client.get("/api/state").status_code, 401)
                self.assertEqual(client.get("/api/state", headers={"Authorization": "Bearer incorrect"}).status_code, 401)
                response = client.get("/api/state", headers={"Authorization": "Bearer test-gateway-secret"})
                self.assertEqual(response.status_code, 200)
                self.assertNotIn("test-gateway-secret", response.text)

    def test_local_console_retains_its_origin_boundary(self):
        with patch.dict(os.environ, {"ROBOT_WEB_TOKEN": ""}):
            with TestClient(server.api) as client:
                self.assertEqual(client.post("/api/stop", headers={"Origin": "https://external.example"}).status_code, 403)
                self.assertEqual(client.post("/api/stop", headers={"Origin": "http://127.0.0.1:8765"}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
