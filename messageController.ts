import axios from "axios";

export const fetchUserDetail = async (data: string) => {
  try {
    const response = await axios.get(`${process.env.API_URL}/user/profile`, {
      headers: {
        Authorization: `Bearer ${data}`,
      },
    });

    return response.data.user.id;
  } catch (err) {
    console.log(err);
  }
};