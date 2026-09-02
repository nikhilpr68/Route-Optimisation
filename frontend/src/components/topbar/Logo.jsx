import React from "react";
import { useNavigate } from "react-router-dom";
import BrandLogo from "../BrandLogo";

const Logo = () => {
  const navigate = useNavigate();

  return (
    <BrandLogo
      compact
      showTagline={false}
      size={32}
      onClick={() => navigate("/home")}
    />
  );
};

export default Logo;
