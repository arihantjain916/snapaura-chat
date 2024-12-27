import axios from "axios";

import jwt from "jsonwebtoken";

export const protect = async (req: any, res: any, next: () => void) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string);

      if (!decoded) {
        return res
          .status(401)
          .json({ message: "Not authorized, token failed" });
      }

      const response = await axios.get(`${process.env.API_URL}/user/profile`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      req.user = response.data.user;

      next();
    } catch (error) {
      res.status(401).json({ message: "Not authorized, token failed" });
    }
  } else {
    res.status(401).json({ message: "Not authorized, no token" });
  }
};
